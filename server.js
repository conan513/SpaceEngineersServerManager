import express from 'express';
import fs from 'fs/promises';
import { existsSync } from 'fs';
import path from 'path';
import os from 'os';
import { spawn, exec } from 'child_process';
import util from 'util';
import xml2js from 'xml2js';
import AdmZip from 'adm-zip';
import { fileURLToPath } from 'url';
import crypto from 'crypto';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Helper to load configurations
const CONFIG_FILE = path.join(__dirname, 'config.json');

let config = {
  port: 8080,
  steamCmdPath: 'steamcmd',
  winePrefixPath: '~/.local/share/se-server-manager/wineprefix',
  serverFilesPath: '~/.local/share/se-server-manager/server-files',
  serverDataPath: '~/.local/share/se-server-manager/server-data',
  backupsPath: '~/.local/share/se-server-manager/backups',
  autoBackupEnabled: true,
  autoBackupIntervalHours: 6,
  autoBackupRetentionCount: 10,
  autoUpdateOnStart: false,
  adminPasswordHash: '',
  adminSalt: ''
};

// Resolve paths (expand ~ to home directory)
function resolvePath(p) {
  if (typeof p !== 'string') return p;
  if (p.startsWith('~')) {
    return path.join(os.homedir(), p.slice(1));
  }
  return path.resolve(p);
}

const execAsync = util.promisify(exec);

async function getWinePath(linuxPath) {
  try {
    // Run winepath inside a shell command to resolve Windows-style mapped drive path
    const { stdout } = await execAsync(`winepath -w "${linuxPath}"`);
    return stdout.trim();
  } catch (err) {
    // Fallback if winepath fails
    const username = os.userInfo().username;
    const absolute = path.resolve(linuxPath);
    return `Z:${absolute.replace(/\//g, '\\')}`;
  }
}

// Load configuration
async function loadConfig() {
  try {
    if (existsSync(CONFIG_FILE)) {
      const data = await fs.readFile(CONFIG_FILE, 'utf-8');
      config = { ...config, ...JSON.parse(data) };
    }
  } catch (err) {
    console.error('Error loading config.json:', err);
  }
}

// Save configuration
async function saveConfig() {
  try {
    await fs.writeFile(CONFIG_FILE, JSON.stringify(config, null, 2), 'utf-8');
  } catch (err) {
    console.error('Error saving config.json:', err);
  }
}

await loadConfig();

const PORT = config.port;
const winePrefixPath = resolvePath(config.winePrefixPath);
const serverFilesPath = resolvePath(config.serverFilesPath);
const serverDataPath = resolvePath(config.serverDataPath);
const backupsPath = resolvePath(config.backupsPath);
const CONFIG_FILE_PATH = path.join(serverDataPath, 'SpaceEngineers-Dedicated.cfg');
const MODS_JSON_PATH = path.join(__dirname, 'mods.json'); // persists {id, title} list

// Ensure essential directories exist
await fs.mkdir(serverDataPath, { recursive: true });
await fs.mkdir(backupsPath, { recursive: true });
await fs.mkdir(path.join(serverDataPath, 'Saves'), { recursive: true });

// Server state variables
let sedsProcess = null;
let serverStatus = 'STOPPED'; // STOPPED, STARTING, RUNNING, STOPPING, UPDATING
let serverUptimeStart = null;
let resourceUsage = { cpu: 0, memory: 0 };
let logHistory = [];
let logClients = [];
let resourceInterval = null;
let autoBackupInterval = null;
let logFileTailProcess = null;
let logFileLastSize = 0;
let logFilePollInterval = null;

// Add logs to memory and stream to SSE clients
function addLog(text, type = 'info') {
  const logEntry = {
    timestamp: new Date().toISOString(),
    type,
    text: text.trim()
  };
  logHistory.push(logEntry);
  if (logHistory.length > 1000) logHistory.shift();

  logClients.forEach(client => {
    client.write(`data: ${JSON.stringify(logEntry)}\n\n`);
  });
  console.log(`[${type.toUpperCase()}] ${text.trim()}`);
}

// Find PIDs of running server under current user
async function getServerPids() {
  return new Promise((resolve) => {
    const pgrep = spawn('pgrep', ['-u', os.userInfo().username, '-f', 'SpaceEngineersDedicated.exe']);
    let output = '';
    pgrep.stdout.on('data', data => { output += data.toString(); });
    pgrep.on('close', () => {
      const pids = output.split('\n').map(p => p.trim()).filter(Boolean);
      resolve(pids);
    });
  });
}

// Query CPU & Memory resource usage of Space Engineers processes
async function updateResourceUsage() {
  if (serverStatus !== 'RUNNING' && serverStatus !== 'STARTING') {
    resourceUsage = { cpu: 0, memory: 0 };
    return;
  }

  const pids = await getServerPids();
  if (pids.length === 0) {
    if (serverStatus === 'RUNNING') {
      addLog('Space Engineers process no longer detected.', 'warning');
      handleServerExit(-1);
    }
    resourceUsage = { cpu: 0, memory: 0 };
    return;
  }

  let totalCpu = 0;
  let totalMem = 0;

  for (const pid of pids) {
    await new Promise((resolve) => {
      const ps = spawn('ps', ['-p', pid, '-o', '%cpu,rss', '--no-headers']);
      let out = '';
      ps.stdout.on('data', data => { out += data.toString(); });
      ps.on('close', () => {
        const parts = out.trim().split(/\s+/);
        if (parts.length >= 2) {
          totalCpu += parseFloat(parts[0]) || 0;
          totalMem += (parseInt(parts[1]) || 0) / 1024; // KB to MB
        }
        resolve();
      });
    });
  }

  resourceUsage = {
    cpu: totalCpu.toFixed(1),
    memory: totalMem.toFixed(0)
  };
}

// Start periodic usage monitoring
function startMonitoring() {
  if (resourceInterval) clearInterval(resourceInterval);
  resourceInterval = setInterval(updateResourceUsage, 3000);
}
startMonitoring();

// Load persisted mods list (array of {id, title})
async function loadModsJson() {
  try {
    if (existsSync(MODS_JSON_PATH)) {
      const raw = await fs.readFile(MODS_JSON_PATH, 'utf-8');
      return JSON.parse(raw);
    }
  } catch { /* ignore */ }
  return [];
}

// Save mods list to JSON for persistence
async function saveModsJson(mods) {
  await fs.writeFile(MODS_JSON_PATH, JSON.stringify(mods, null, 2), 'utf-8');
}

// Build <Mods> block for SpaceEngineers-Dedicated.cfg
// Format: <MyObjectBuilder_WorkshopItem> with <PublishedItemId>
function buildCfgModsXmlBlock(mods) {
  if (!mods || mods.length === 0) return '<Mods />';
  const lines = mods.map(m => {
    const id = typeof m === 'object' ? m.id : m;
    return `    <MyObjectBuilder_WorkshopItem>\n      <PublishedItemId>${id}</PublishedItemId>\n      <PublishedFileId>${id}</PublishedFileId>\n      <Title />\n      <Enabled>true</Enabled>\n    </MyObjectBuilder_WorkshopItem>`;
  }).join('\n');
  return `<Mods>\n${lines}\n  </Mods>`;
}

// Build <Mods> block for Sandbox_config.sbc
// Format: <ModItem FriendlyName="..."> with <Name>, <PublishedFileId>, <PublishedServiceName>
function buildSandboxModsXmlBlock(mods) {
  if (!mods || mods.length === 0) return '<Mods />';
  const lines = mods.map(m => {
    const id = typeof m === 'object' ? m.id : m;
    const isDep = (typeof m === 'object' && m.isDependency) ? '\n      <IsDependency>true</IsDependency>' : '';
    return `    <ModItem FriendlyName="*Unknown*">\n      <Name>${id}.sbm</Name>\n      <PublishedFileId>${id}</PublishedFileId>\n      <PublishedServiceName>Steam</PublishedServiceName>${isDep}\n    </ModItem>`;
  }).join('\n');
  return `<Mods>\n${lines}\n  </Mods>`;
}

// Replace the <Mods> block in any XML file using raw string manipulation (preserves namespaces)
async function writeModsToXmlFile(filePath, modsBlock) {
  if (!existsSync(filePath)) {
    addLog(`writeModsToXmlFile: not found: ${filePath}`, 'warning');
    return false;
  }
  let content = await fs.readFile(filePath, 'utf-8');
  const modsRegex = /<Mods\s*\/>|<Mods[\s\S]*?<\/Mods>/i;
  if (modsRegex.test(content)) {
    content = content.replace(modsRegex, modsBlock);
  } else {
    content = content.replace(/(<\/[A-Za-z:]+>\s*)$/, `  ${modsBlock}\n$1`);
  }
  await fs.writeFile(filePath, content, 'utf-8');
  return true;
}

// Sync mods from mods.json into the active world's sbc files before server start
async function syncModsToActiveWorld() {
  try {
    const mods = await loadModsJson();
    if (mods.length === 0) {
      addLog('No mods in mods.json — skipping pre-start sync.', 'info');
      return;
    }

    addLog(`Pre-start: syncing ${mods.length} mod(s) and enforcing Experimental Mode...`, 'info');

    // 1. Force Experimental Mode in SpaceEngineers-Dedicated.cfg
    const mainCfg = await readSedsConfig();
    if (mainCfg) {
      if (!mainCfg.MyConfigDedicated) mainCfg.MyConfigDedicated = {};
      if (!mainCfg.MyConfigDedicated.SessionSettings) mainCfg.MyConfigDedicated.SessionSettings = {};
      mainCfg.MyConfigDedicated.SessionSettings.ExperimentalMode = 'true';
      await writeSedsConfig(mainCfg);
    }

    // 2. Write to .cfg mods block
    const cfgBlock = buildCfgModsXmlBlock(mods);
    await writeModsToXmlFile(CONFIG_FILE_PATH, cfgBlock);

    // 3. Write to Sandbox_config.sbc with correct ModItem format
    const paths = await getActiveWorldPaths();
    if (paths) {
      // Force Experimental Mode in world save files
      await updateSettingsInSbcFile(paths.sandboxConfigPath, { experimentalMode: true });

      const sbcBlock = buildSandboxModsXmlBlock(mods);
      const okConfig = await writeModsToXmlFile(paths.sandboxConfigPath, sbcBlock);
      
      if (okConfig) addLog(`✅ Pre-start sync: mods written to Sandbox_config.sbc`, 'info');
    } else {
      addLog('No active world paths resolved — mods will be loaded from .cfg on launch.', 'warning');
    }
  } catch (err) {
    addLog(`Warning: pre-start mod sync failed — ${err.message}`, 'warning');
  }
}

// Handle server startup
async function startServer() {
  if (sedsProcess || serverStatus === 'RUNNING' || serverStatus === 'STARTING') {
    addLog('Server is already running or starting.', 'warning');
    return false;
  }

  serverStatus = 'STARTING';
  serverUptimeStart = Date.now();
  addLog('Starting Space Engineers dedicated server...', 'info');

  // Sync mods into the active world before launching
  await syncModsToActiveWorld();

  const startScript = path.join(__dirname, 'scripts', 'start-server.sh');
  
  sedsProcess = spawn('bash', [startScript], {
    env: {
      ...process.env,
      WINEPREFIX: winePrefixPath,
      SERVER_FILES: serverFilesPath,
      SERVER_DATA: serverDataPath
    }
  });

  sedsProcess.stdout.on('data', (data) => {
    const lines = data.toString().split('\n');
    lines.forEach(line => {
      if (line.trim()) {
        addLog(line, 'stdout');
        // Space Engineers server indicates readiness with specific lines:
        if (line.includes('Game ready...') || line.includes('Server started') || line.includes('Update finished')) {
          serverStatus = 'RUNNING';
        }
      }
    });
  });

  sedsProcess.stderr.on('data', (data) => {
    const lines = data.toString().split('\n');
    lines.forEach(line => {
      if (line.trim()) addLog(line, 'stderr');
    });
  });

  sedsProcess.on('close', (code) => {
    addLog(`Launcher process closed with code ${code}`, 'info');
    handleServerExit(code);
  });

  // After 20 seconds, assume it's running if no crash happened
  setTimeout(() => {
    if (serverStatus === 'STARTING') {
      serverStatus = 'RUNNING';
      addLog('Server state transitioned to RUNNING (timeout-based).', 'info');
    }
  }, 20000);

  // Start tailing the game log file to stream real SEDS output
  startLogFileTail();

  return true;
}

// Handle server exit cleanup
function handleServerExit(code) {
  stopLogFileTail();
  sedsProcess = null;
  serverStatus = 'STOPPED';
  serverUptimeStart = null;
  resourceUsage = { cpu: 0, memory: 0 };
  addLog(`Server stopped. (Exit code: ${code})`, 'info');
}

// Start tailing the game log file
function startLogFileTail() {
  stopLogFileTail(); // Clean any existing watcher

  addLog(`Starting log file watcher in: ${serverDataPath}`, 'info');

  // Reset position tracker - we'll seek to end so we don't re-read old log
  logFileLastSize = 0;
  let resolvedLogPath = null; // Will be determined on first successful find

  // Candidate log locations (SE may write to root or Logs/ subdirectory)
  const candidatePaths = [
    path.join(serverDataPath, 'SpaceEngineers-Dedicated.log'),
    path.join(serverDataPath, 'Logs', 'SpaceEngineers-Dedicated.log'),
  ];

  async function findCurrentLogFile() {
    let best = null;
    let bestMtime = 0;
    for (const candidate of candidatePaths) {
      try {
        const stat = await fs.stat(candidate);
        if (stat.mtimeMs > bestMtime) {
          bestMtime = stat.mtimeMs;
          best = candidate;
        }
      } catch { /* file doesn't exist yet */ }
    }
    return best;
  }

  // Poll every 500ms for new content in the log file
  logFilePollInterval = setInterval(async () => {
    try {
      // Resolve the log file path dynamically if not found yet
      if (!resolvedLogPath) {
        resolvedLogPath = await findCurrentLogFile();
        if (!resolvedLogPath) return; // Log file not created yet
        addLog(`Game log file found: ${resolvedLogPath}`, 'info');
        const stat = await fs.stat(resolvedLogPath);
        logFileLastSize = stat.size; // Start reading from current end
        return;
      }

      const stat = await fs.stat(resolvedLogPath);
      const currentSize = stat.size;

      if (currentSize <= logFileLastSize) return;

      // Read only the new bytes appended to the file
      const fd = await fs.open(resolvedLogPath, 'r');
      const bytesToRead = currentSize - logFileLastSize;
      const buffer = Buffer.alloc(bytesToRead);
      await fd.read(buffer, 0, bytesToRead, logFileLastSize);
      await fd.close();

      logFileLastSize = currentSize;

      const newContent = buffer.toString('utf-8');
      const lines = newContent.split('\n');
      lines.forEach(line => {
        const trimmed = line.trim();
        if (!trimmed) return;

        // Detect server readiness from log
        if (trimmed.includes('Server successfully started') || trimmed.includes('MySandboxGame.Initialize() - END') || trimmed.includes('Game ready')) {
          if (serverStatus === 'STARTING') {
            serverStatus = 'RUNNING';
            addLog('✅ Server is now RUNNING (detected from game log).', 'info');
          }
        }

        // Detect crash/shutdown from log
        if (trimmed.includes('Logging off Steam') || trimmed.includes('Shutting down server')) {
          if (serverStatus === 'RUNNING' || serverStatus === 'STARTING') {
            addLog('⚠️ Shutdown detected in game log.', 'warning');
          }
        }

        addLog(trimmed, 'stdout');
      });
    } catch (err) {
      // If log file was rotated/replaced, reset so we re-discover it next poll
      if (err.code === 'ENOENT') {
        resolvedLogPath = null;
        logFileLastSize = 0;
      }
      // Ignore other transient read errors
    }
  }, 500);
}


// Stop tailing the game log file
function stopLogFileTail() {
  if (logFilePollInterval) {
    clearInterval(logFilePollInterval);
    logFilePollInterval = null;
  }
  logFileLastSize = 0;
}

// Stop server
async function stopServer() {
  if (serverStatus === 'STOPPED' || serverStatus === 'STOPPING') {
    addLog('Server is already stopped.', 'warning');
    return false;
  }

  serverStatus = 'STOPPING';
  addLog('Stopping Space Engineers dedicated server...', 'info');

  // Find pids and kill them
  const pids = await getServerPids();
  if (pids.length > 0) {
    addLog(`Sending SIGTERM to Space Engineers process(es): ${pids.join(', ')}`, 'info');
    for (const pid of pids) {
      try {
        process.kill(parseInt(pid), 'SIGTERM');
      } catch (e) {
        // process might have exited already
      }
    }
    
    // Wait for shutdown or kill forcefully after 15 seconds
    setTimeout(async () => {
      const remainingPids = await getServerPids();
      if (remainingPids.length > 0) {
        addLog(`Force killing processes: ${remainingPids.join(', ')}`, 'warning');
        for (const pid of remainingPids) {
          try { process.kill(parseInt(pid), 'SIGKILL'); } catch(e) {}
        }
      }
      handleServerExit(0);
    }, 15000);
  } else {
    if (sedsProcess) {
      sedsProcess.kill('SIGTERM');
    } else {
      handleServerExit(0);
    }
  }
  return true;
}

// Trigger SteamCMD update
async function updateGameServer() {
  if (serverStatus !== 'STOPPED') {
    addLog('Stopping server before triggering update...', 'info');
    await stopServer();
    // Wait for server to stop
    while (serverStatus !== 'STOPPED') {
      await new Promise(r => setTimeout(r, 1000));
    }
  }

  serverStatus = 'UPDATING';
  addLog('Starting SteamCMD game update...', 'info');

  const steamcmd = config.steamCmdPath;
  const args = [
    '+login', 'anonymous',
    '+force_install_dir', serverFilesPath,
    '+app_update', '298740', 'validate',
    '+quit'
  ];

  addLog(`Running command: ${steamcmd} ${args.join(' ')}`, 'info');

  const updateProc = spawn(steamcmd, args);

  updateProc.stdout.on('data', data => {
    const lines = data.toString().split('\n');
    lines.forEach(line => {
      if (line.trim()) addLog(line, 'stdout');
    });
  });

  updateProc.stderr.on('data', data => {
    const lines = data.toString().split('\n');
    lines.forEach(line => {
      if (line.trim()) addLog(line, 'stderr');
    });
  });

  updateProc.on('close', code => {
    serverStatus = 'STOPPED';
    if (code === 0) {
      addLog('Game update completed successfully!', 'info');
    } else {
      addLog(`SteamCMD exited with error code ${code}`, 'stderr');
    }
  });
}

// Backup Manager
async function triggerBackup(type = 'manual') {
  addLog(`Starting backup of saves (${type})...`, 'info');
  const savesPath = path.join(serverDataPath, 'Saves');
  if (!existsSync(savesPath)) {
    addLog('No saves directory found. Backup skipped.', 'warning');
    return null;
  }

  try {
    const dateStr = new Date().toISOString().replace(/[:.]/g, '-');
    const zipFilename = `backup_${type}_${dateStr}.zip`;
    const zipFilePath = path.join(backupsPath, zipFilename);

    const zip = new AdmZip();
    zip.addLocalFolder(savesPath);
    await zip.writeZipPromise(zipFilePath);

    addLog(`Backup created successfully: ${zipFilename}`, 'info');

    // Run Retention Policy
    if (type === 'auto') {
      await enforceBackupRetention();
    }

    return zipFilename;
  } catch (err) {
    addLog(`Backup creation failed: ${err.message}`, 'stderr');
    return null;
  }
}

async function enforceBackupRetention() {
  try {
    const files = await fs.readdir(backupsPath);
    const autoBackups = [];

    for (const file of files) {
      if (file.startsWith('backup_auto_') && file.endsWith('.zip')) {
        const filePath = path.join(backupsPath, file);
        const stat = await fs.stat(filePath);
        autoBackups.push({ name: file, path: filePath, mtime: stat.mtimeMs });
      }
    }

    // Sort by mtime (oldest first)
    autoBackups.sort((a, b) => a.mtime - b.mtime);

    // Keep only the latest N
    const toDeleteCount = autoBackups.length - config.autoBackupRetentionCount;
    if (toDeleteCount > 0) {
      addLog(`Deleting ${toDeleteCount} older auto-backups to enforce retention policy...`, 'info');
      for (let i = 0; i < toDeleteCount; i++) {
        await fs.unlink(autoBackups[i].path);
        addLog(`Deleted old backup: ${autoBackups[i].name}`, 'info');
      }
    }
  } catch (err) {
    console.error('Error enforcing backup retention:', err);
  }
}

// Start auto backup schedule
function startAutoBackupSchedule() {
  if (autoBackupInterval) clearInterval(autoBackupInterval);
  if (config.autoBackupEnabled) {
    const intervalMs = config.autoBackupIntervalHours * 60 * 60 * 1000;
    autoBackupInterval = setInterval(() => {
      triggerBackup('auto');
    }, intervalMs);
    addLog(`Auto-backup enabled. Interval: every ${config.autoBackupIntervalHours} hours.`, 'info');
  } else {
    addLog('Auto-backup is disabled.', 'info');
  }
}
startAutoBackupSchedule();


// Configuration Parsing & Merging

async function readSedsConfig() {
  if (!existsSync(CONFIG_FILE_PATH)) {
    return null;
  }
  const fileContent = await fs.readFile(CONFIG_FILE_PATH, 'utf-8');
  const parser = new xml2js.Parser({ explicitArray: false });
  const result = await parser.parseStringPromise(fileContent);
  return result;
}

// Build the <Mods> block for SpaceEngineers-Dedicated.cfg (kept for writeSedsConfig compatibility)
// (actual build functions are buildCfgModsXmlBlock / buildSandboxModsXmlBlock above)

async function writeSedsConfig(parsedData) {
  // Use xml2js Builder but preserve original file structure for mods.
  // The builder is only used for non-mods fields (names, ports, etc.).
  const builder = new xml2js.Builder({
    xmldec: { version: '1.0', encoding: 'UTF-8' },
    renderOpts: { pretty: true, indent: '  ', newline: '\n' }
  });
  const xml = builder.buildObject(parsedData);
  await fs.writeFile(CONFIG_FILE_PATH, xml, 'utf-8');
}

// Get paths for Sandbox_config.sbc and Sandbox.sbc of the active world
async function getActiveWorldPaths() {
  try {
    const mainCfg = await readSedsConfig();
    if (!mainCfg) return null;

    let loadWorld = mainCfg.MyConfigDedicated?.LoadWorld;
    let worldName = mainCfg.MyConfigDedicated?.WorldName;

    let worldFolder = '';
    if (loadWorld) {
      // Parse out world directory from windows/linux path
      worldFolder = path.basename(loadWorld.replace(/\\/g, '/'));
    } else if (worldName) {
      worldFolder = worldName;
    }

    if (!worldFolder) return null;

    const folderPath = path.join(serverDataPath, 'Saves', worldFolder);
    return {
      folderPath,
      sandboxConfigPath: path.join(folderPath, 'Sandbox_config.sbc'),
      sandboxPath: path.join(folderPath, 'Sandbox.sbc')
    };
  } catch (err) {
    console.warn('Error resolving active world paths:', err.message);
  }
  return null;
}

// Update settings inside a specific SBC save file (independent of the root tag)
async function updateSettingsInSbcFile(filePath, updates) {
  if (!existsSync(filePath)) return false;
  try {
    const content = await fs.readFile(filePath, 'utf-8');
    const parser = new xml2js.Parser({ explicitArray: false });
    const parsed = await parser.parseStringPromise(content);
    
    const rootKey = Object.keys(parsed)[0];
    if (!parsed[rootKey]) return false;
    
    // Ensure Settings object exists
    if (!parsed[rootKey].Settings) {
      parsed[rootKey].Settings = {};
    }
    const s = parsed[rootKey].Settings;

    // Apply updates
    if (updates.gameMode !== undefined) s.GameMode = updates.gameMode;
    if (updates.maxPlayers !== undefined) s.MaxPlayers = updates.maxPlayers.toString();
    if (updates.inventorySizeMultiplier !== undefined) s.InventorySizeMultiplier = updates.inventorySizeMultiplier.toString();
    if (updates.assemblerSpeedMultiplier !== undefined) s.AssemblerSpeedMultiplier = updates.assemblerSpeedMultiplier.toString();
    if (updates.assemblerEfficiencyMultiplier !== undefined) s.AssemblerEfficiencyMultiplier = updates.assemblerEfficiencyMultiplier.toString();
    if (updates.refinerySpeedMultiplier !== undefined) s.RefinerySpeedMultiplier = updates.refinerySpeedMultiplier.toString();
    if (updates.welderSpeedMultiplier !== undefined) s.WelderSpeedMultiplier = updates.welderSpeedMultiplier.toString();
    if (updates.grinderSpeedMultiplier !== undefined) s.GrinderSpeedMultiplier = updates.grinderSpeedMultiplier.toString();
    if (updates.autoSaveInMinutes !== undefined) s.AutoSaveInMinutes = updates.autoSaveInMinutes.toString();
    if (updates.enableIngameScripts !== undefined) s.EnableIngameScripts = updates.enableIngameScripts.toString();
    if (updates.viewDistance !== undefined) s.ViewDistance = updates.viewDistance.toString();
    if (updates.experimentalMode !== undefined) s.ExperimentalMode = updates.experimentalMode.toString();

    const builder = new xml2js.Builder({
      xmldec: { version: '1.0' },
      renderOpts: { pretty: true, indent: '  ', newline: '\n' }
    });
    const xml = builder.buildObject(parsed);
    await fs.writeFile(filePath, xml, 'utf-8');
    return true;
  } catch (err) {
    addLog(`Error updating settings in ${path.basename(filePath)}: ${err.message}`, 'warning');
    return false;
  }
}

// Auth helpers and middleware
const sessions = new Set();

function hashPassword(password, salt) {
  return crypto.pbkdf2Sync(password, salt, 10000, 64, 'sha512').toString('hex');
}

function generateSalt() {
  return crypto.randomBytes(16).toString('hex');
}

function generateToken() {
  return crypto.randomBytes(32).toString('hex');
}

function requireAdmin(req, res, next) {
  let token = req.query.token;
  if (!token) {
    const authHeader = req.headers.authorization;
    if (authHeader && authHeader.startsWith('Bearer ')) {
      token = authHeader.substring(7);
    }
  }
  if (token && sessions.has(token)) {
    return next();
  }
  res.status(401).json({ error: 'Unauthorized' });
}

// Express app setup
const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Auth API endpoints
app.post('/api/admin/setup', async (req, res) => {
  if (config.adminPasswordHash) {
    return res.status(400).json({ error: 'Admin password has already been set.' });
  }
  const { password } = req.body;
  if (!password || password.length < 6) {
    return res.status(400).json({ error: 'Password must be at least 6 characters long.' });
  }

  try {
    const salt = generateSalt();
    const hash = hashPassword(password, salt);
    config.adminPasswordHash = hash;
    config.adminSalt = salt;
    await saveConfig();
    
    // Auto login on setup
    const token = generateToken();
    sessions.add(token);

    addLog('Admin password set successfully during setup.', 'info');
    res.json({ success: true, token });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/admin/login', async (req, res) => {
  if (!config.adminPasswordHash) {
    return res.status(400).json({ error: 'Admin account has not been set up yet.' });
  }
  const { password } = req.body;
  if (!password) {
    return res.status(400).json({ error: 'Password is required.' });
  }

  const hash = hashPassword(password, config.adminSalt);
  if (hash === config.adminPasswordHash) {
    const token = generateToken();
    sessions.add(token);
    res.json({ success: true, token });
  } else {
    res.status(401).json({ error: 'Incorrect password.' });
  }
});

app.post('/api/admin/logout', (req, res) => {
  const authHeader = req.headers.authorization;
  if (authHeader && authHeader.startsWith('Bearer ')) {
    const token = authHeader.substring(7);
    sessions.delete(token);
  }
  res.json({ success: true });
});

// 1. GET STATUS (auth-aware: admin gets full config, public gets safe subset)
app.get('/api/status', async (req, res) => {
  // Check if request is authenticated
  let isAdminReq = false;
  let token = req.query.token;
  if (!token) {
    const authHeader = req.headers.authorization;
    if (authHeader && authHeader.startsWith('Bearer ')) token = authHeader.substring(7);
  }
  if (token && sessions.has(token)) isAdminReq = true;

  let activeWorld = 'None';
  let serverName = 'Space Engineers Server';
  let serverPort = 27016;
  let maxPlayers = 4;
  let gameMode = 'Survival';
  let mods = [];
  try {
    const mainCfg = await readSedsConfig();
    if (mainCfg) {
      activeWorld = mainCfg.MyConfigDedicated?.WorldName || 'Default World';
      serverName = mainCfg.MyConfigDedicated?.ServerName || serverName;
      serverPort = mainCfg.MyConfigDedicated?.Port || serverPort;
      maxPlayers = mainCfg.MyConfigDedicated?.SessionSettings?.MaxPlayers || maxPlayers;
      gameMode = mainCfg.MyConfigDedicated?.SessionSettings?.GameMode || gameMode;
    }
  } catch(e) {}

  try { mods = await loadModsJson(); } catch(e) {}

  const baseResponse = {
    status: serverStatus,
    uptime: serverUptimeStart ? Math.floor((Date.now() - serverUptimeStart) / 1000) : 0,
    cpu: resourceUsage.cpu,
    memory: resourceUsage.memory,
    activeWorld,
    serverName,
    serverPort,
    maxPlayers,
    gameMode,
    mods,
    adminSetup: !!config.adminPasswordHash
  };

  if (isAdminReq) {
    let worlds = [];
    try {
      const savesPath = path.join(serverDataPath, 'Saves');
      if (existsSync(savesPath)) {
        const files = await fs.readdir(savesPath);
        for (const file of files) {
          const stat = await fs.stat(path.join(savesPath, file));
          if (stat.isDirectory()) worlds.push(file);
        }
      }
    } catch(e) {}
    return res.json({ ...baseResponse, worlds, config });
  }

  res.json(baseResponse);
});

// 2. SERVER CONTROL ACTIONS (admin only)
app.post('/api/control', requireAdmin, async (req, res) => {
  const { action } = req.body;
  if (action === 'start') {
    const success = await startServer();
    return res.json({ success, status: serverStatus });
  } else if (action === 'stop') {
    const success = await stopServer();
    return res.json({ success, status: serverStatus });
  } else if (action === 'restart') {
    await stopServer();
    while (serverStatus !== 'STOPPED') {
      await new Promise(r => setTimeout(r, 1000));
    }
    const success = await startServer();
    return res.json({ success, status: serverStatus });
  } else if (action === 'update') {
    updateGameServer(); // runs in background
    return res.json({ success: true, status: 'UPDATING' });
  }
  res.status(400).json({ error: 'Invalid action' });
});

// 3. GET FULL / REALTIME LOGS STREAM (admin only)
app.get('/api/logs/stream', requireAdmin, (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  // Send historical logs in buffer
  logHistory.forEach(log => {
    res.write(`data: ${JSON.stringify(log)}\n\n`);
  });

  logClients.push(res);

  req.on('close', () => {
    logClients = logClients.filter(c => c !== res);
  });
});

// 4. GET SYSTEM / GAME LOGS (admin only)
app.get('/api/logs/full', requireAdmin, async (req, res) => {
  try {
    const logFilePath = path.join(serverDataPath, 'SpaceEngineers-Dedicated.log');
    if (existsSync(logFilePath)) {
      const data = await fs.readFile(logFilePath, 'utf-8');
      const lines = data.split('\n').slice(-1000).join('\n'); // Last 1000 lines
      return res.send(lines);
    }
  } catch(e) {}
  res.send(logHistory.map(l => `[${l.type}] ${l.text}`).join('\n'));
});

// 5. GET CONFIGURATIONS (admin only)
app.get('/api/config', requireAdmin, async (req, res) => {
  try {
    const mainCfg = await readSedsConfig();
    if (!mainCfg) {
      return res.status(404).json({ error: 'Configuration file not found' });
    }

    const dedicated = mainCfg.MyConfigDedicated || {};
    const settings = dedicated.SessionSettings || {};

    const responseData = {
      serverName: dedicated.ServerName || '',
      port: dedicated.Port || 27016,
      ip: dedicated.IP || '0.0.0.0',
      worldName: dedicated.WorldName || 'Default World',
      pauseGameWhenEmpty: dedicated.PauseGameWhenEmpty === 'true' || dedicated.PauseGameWhenEmpty === true,
      ignoreLastSession: dedicated.IgnoreLastSession === 'true' || dedicated.IgnoreLastSession === true,
      
      // Session Settings
      gameMode: settings.GameMode || 'Survival',
      maxPlayers: parseInt(settings.MaxPlayers) || 4,
      inventorySizeMultiplier: parseFloat(settings.InventorySizeMultiplier) || 10,
      assemblerSpeedMultiplier: parseFloat(settings.AssemblerSpeedMultiplier) || 3,
      assemblerEfficiencyMultiplier: parseFloat(settings.AssemblerEfficiencyMultiplier) || 3,
      refinerySpeedMultiplier: parseFloat(settings.RefinerySpeedMultiplier) || 3,
      welderSpeedMultiplier: parseFloat(settings.WelderSpeedMultiplier) || 2,
      grinderSpeedMultiplier: parseFloat(settings.GrinderSpeedMultiplier) || 2,
      autoSaveInMinutes: parseInt(settings.AutoSaveInMinutes) || 5,
      enableIngameScripts: settings.EnableIngameScripts === 'true' || settings.EnableIngameScripts === true,
      experimentalMode: settings.ExperimentalMode === 'true' || settings.ExperimentalMode === true,
      viewDistance: parseInt(settings.ViewDistance) || 15000
    };

    res.json(responseData);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 6. UPDATE CONFIGURATIONS (admin only)
app.post('/api/config', requireAdmin, async (req, res) => {
  try {
    const updates = req.body;
    const mainCfg = await readSedsConfig();
    if (!mainCfg) {
      return res.status(404).json({ error: 'Config file not found' });
    }

    if (!mainCfg.MyConfigDedicated) mainCfg.MyConfigDedicated = {};
    if (!mainCfg.MyConfigDedicated.SessionSettings) mainCfg.MyConfigDedicated.SessionSettings = {};

    const d = mainCfg.MyConfigDedicated;
    const s = d.SessionSettings;

    // Apply updates to dedicated config
    if (updates.serverName !== undefined) d.ServerName = updates.serverName;
    if (updates.port !== undefined) d.Port = updates.port.toString();
    if (updates.ip !== undefined) d.IP = updates.ip;
    if (updates.worldName !== undefined) {
      d.WorldName = updates.worldName;
      // Update LoadWorld if it's set
      if (d.LoadWorld) {
        d.LoadWorld = `Z:\\home\\${os.userInfo().username}\\.local\\share\\se-server-manager\\server-data\\Saves\\${updates.worldName}`;
      }
    }
    if (updates.pauseGameWhenEmpty !== undefined) d.PauseGameWhenEmpty = updates.pauseGameWhenEmpty.toString();
    if (updates.ignoreLastSession !== undefined) d.IgnoreLastSession = updates.ignoreLastSession.toString();

    // Session settings updates
    if (updates.gameMode !== undefined) s.GameMode = updates.gameMode;
    if (updates.maxPlayers !== undefined) s.MaxPlayers = updates.maxPlayers.toString();
    if (updates.inventorySizeMultiplier !== undefined) s.InventorySizeMultiplier = updates.inventorySizeMultiplier.toString();
    if (updates.assemblerSpeedMultiplier !== undefined) s.AssemblerSpeedMultiplier = updates.assemblerSpeedMultiplier.toString();
    if (updates.assemblerEfficiencyMultiplier !== undefined) s.AssemblerEfficiencyMultiplier = updates.assemblerEfficiencyMultiplier.toString();
    if (updates.refinerySpeedMultiplier !== undefined) s.RefinerySpeedMultiplier = updates.refinerySpeedMultiplier.toString();
    if (updates.welderSpeedMultiplier !== undefined) s.WelderSpeedMultiplier = updates.welderSpeedMultiplier.toString();
    if (updates.grinderSpeedMultiplier !== undefined) s.GrinderSpeedMultiplier = updates.grinderSpeedMultiplier.toString();
    if (updates.autoSaveInMinutes !== undefined) s.AutoSaveInMinutes = updates.autoSaveInMinutes.toString();
    if (updates.enableIngameScripts !== undefined) s.EnableIngameScripts = updates.enableIngameScripts.toString();
    if (updates.experimentalMode !== undefined) s.ExperimentalMode = updates.experimentalMode.toString();
    if (updates.viewDistance !== undefined) s.ViewDistance = updates.viewDistance.toString();

    await writeSedsConfig(mainCfg);

    // Sync updates to active world configuration file if it exists
    const paths = await getActiveWorldPaths();
    if (paths) {
      const configOk = await updateSettingsInSbcFile(paths.sandboxConfigPath, updates);
      if (configOk) {
        addLog('Synchronized settings to active world Sandbox_config.sbc.', 'info');
      }
    }

    addLog('Configurations updated successfully.', 'info');
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Steam Web API Helper to fetch details of multiple workshop items
async function getModDetails(modIds) {
  if (!modIds || modIds.length === 0) return [];
  try {
    const params = new URLSearchParams();
    params.append('itemcount', modIds.length.toString());
    modIds.forEach((id, idx) => {
      params.append(`publishedfileids[${idx}]`, id);
    });

    const response = await fetch('https://api.steampowered.com/ISteamRemoteStorage/GetPublishedFileDetails/v1/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: params.toString()
    });

    if (!response.ok) {
      return modIds.map(id => ({ id, title: `Workshop Mod #${id}` }));
    }

    const data = await response.json();
    const details = data.response?.publishedfiledetails || [];
    
    return details.map(item => ({
      id: item.publishedfileid,
      title: item.title || `Workshop Mod #${item.publishedfileid}`
    }));
  } catch (err) {
    console.error('Error fetching mod details from Steam API:', err.message);
    return modIds.map(id => ({ id, title: `Workshop Mod #${id}` }));
  }
}

// Recursively fetch all dependency workshop item IDs
async function fetchModDependencies(modId, visited = new Set()) {
  if (visited.has(modId)) return [];
  visited.add(modId);

  try {
    const params = new URLSearchParams();
    params.append('itemcount', '1');
    params.append('publishedfileids[0]', modId);
    params.append('includechildren', 'true');

    const response = await fetch('https://api.steampowered.com/ISteamRemoteStorage/GetPublishedFileDetails/v1/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: params.toString()
    });

    if (!response.ok) return [];

    const data = await response.json();
    const details = data.response?.publishedfiledetails?.[0];
    if (!details || details.result !== 1) return [];

    const dependencies = [];
    const children = details.children || [];
    
    for (const child of children) {
      const childId = child.publishedfileid;
      if (childId && !visited.has(childId)) {
        dependencies.push(childId);
        // Recurse to find sub-dependencies
        const subDeps = await fetchModDependencies(childId, visited);
        dependencies.push(...subDeps);
      }
    }

    return dependencies;
  } catch (err) {
    console.error(`Error fetching dependencies for mod ${modId}:`, err.message);
    return [];
  }
}

// 7. GET MODS LIST (admin only)
app.get('/api/mods', requireAdmin, async (req, res) => {
  try {
    // Primary source: mods.json (has titles, set by POST /api/mods)
    const mods = await loadModsJson();
    if (mods.length > 0) {
      return res.json({ mods });
    }

    // Fallback: read IDs from .cfg and fetch titles from Steam
    let modIds = [];
    if (existsSync(CONFIG_FILE_PATH)) {
      const raw = await fs.readFile(CONFIG_FILE_PATH, 'utf-8');
      const modsBlockMatch = raw.match(/<Mods[\s\S]*?<\/Mods>/i);
      if (modsBlockMatch) {
        modIds = [...modsBlockMatch[0].matchAll(/<PublishedItemId>(\d+)<\/PublishedItemId>/gi)].map(m => m[1]);
      }
    }
    const modsWithDetails = await getModDetails(modIds);
    res.json({ mods: modsWithDetails });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 8. UPDATE MODS LIST (admin only)
app.post('/api/mods', requireAdmin, async (req, res) => {
  try {
    const { mods } = req.body; // Array of { id, title, isDependency? }
    if (!Array.isArray(mods)) return res.status(400).json({ error: 'Mods must be an array' });

    // Normalize: ensure each entry is { id: string, title: string, isDependency?: bool }
    const normalizedMods = mods.map(m => ({
      id: String(typeof m === 'object' ? m.id : m),
      title: (typeof m === 'object' && m.title) ? m.title : String(m.id || m),
      ...(m.isDependency ? { isDependency: true } : {})
    }));

    // 1. Persist to mods.json (source of truth for our manager)
    await saveModsJson(normalizedMods);
    addLog(`mods.json saved with ${normalizedMods.length} mod(s)`, 'info');

    // 2. Write to SpaceEngineers-Dedicated.cfg (MyObjectBuilder_WorkshopItem/PublishedItemId)
    const cfgBlock = buildCfgModsXmlBlock(normalizedMods);
    const cfgOk = await writeModsToXmlFile(CONFIG_FILE_PATH, cfgBlock);
    if (!cfgOk) {
      addLog('SpaceEngineers-Dedicated.cfg not found — mods saved to mods.json only.', 'warning');
    }

    // 3. Write to Sandbox_config.sbc and Sandbox.sbc (ModItem/PublishedFileId format)
    const paths = await getActiveWorldPaths();
    if (paths) {
      // Force Experimental Mode in world configuration file if we have mods
      if (normalizedMods.length > 0) {
        await updateSettingsInSbcFile(paths.sandboxConfigPath, { experimentalMode: true });

        // Also force in SpaceEngineers-Dedicated.cfg
        const mainCfg = await readSedsConfig();
        if (mainCfg) {
          if (!mainCfg.MyConfigDedicated) mainCfg.MyConfigDedicated = {};
          if (!mainCfg.MyConfigDedicated.SessionSettings) mainCfg.MyConfigDedicated.SessionSettings = {};
          mainCfg.MyConfigDedicated.SessionSettings.ExperimentalMode = 'true';
          await writeSedsConfig(mainCfg);
        }
      }

      const sbcBlock = buildSandboxModsXmlBlock(normalizedMods);
      const okConfig = await writeModsToXmlFile(paths.sandboxConfigPath, sbcBlock);
      
      if (okConfig) addLog(`✅ Sync: mods written to Sandbox_config.sbc`, 'info');
    } else {
      addLog('No active world paths resolved — will sync on next server start.', 'warning');
    }

    res.json({ success: true, count: normalizedMods.length });
  } catch (err) {
    addLog(`Error saving mods: ${err.message}`, 'stderr');
    res.status(500).json({ error: err.message });
  }
});

// 8b. RESOLVE MOD DEPENDENCIES (admin only)
app.post('/api/mods/resolve', requireAdmin, async (req, res) => {
  const { modId } = req.body;
  if (!modId) return res.status(400).json({ error: 'modId is required' });

  try {
    addLog(`Resolving dependencies for mod ID ${modId} from Steam Workshop...`, 'info');
    const visited = new Set();
    const dependencies = await fetchModDependencies(modId, visited);
    
    // Include the mod itself in the lookups
    const allIds = [modId, ...dependencies];
    
    // Fetch details (Titles)
    const details = await getModDetails(allIds);
    res.json({ mods: details });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 9. GET BACKUPS (admin only)
app.get('/api/backups', requireAdmin, async (req, res) => {
  try {
    const files = await fs.readdir(backupsPath);
    const backups = [];
    for (const file of files) {
      if (file.endsWith('.zip')) {
        const filePath = path.join(backupsPath, file);
        const stat = await fs.stat(filePath);
        backups.push({
          filename: file,
          size: stat.size,
          createdAt: stat.mtime
        });
      }
    }
    backups.sort((a, b) => b.createdAt - a.createdAt); // newest first
    res.json({ backups });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 10. CREATE BACKUP (admin only)
app.post('/api/backups/create', requireAdmin, async (req, res) => {
  const zipFilename = await triggerBackup('manual');
  if (zipFilename) {
    res.json({ success: true, filename: zipFilename });
  } else {
    res.status(500).json({ error: 'Failed to create backup' });
  }
});

// 11. RESTORE BACKUP (admin only)
app.post('/api/backups/restore', requireAdmin, async (req, res) => {
  const { filename } = req.body;
  if (!filename) return res.status(400).json({ error: 'Filename is required' });

  const zipFilePath = path.join(backupsPath, filename);
  if (!existsSync(zipFilePath)) return res.status(404).json({ error: 'Backup file not found' });

  if (serverStatus !== 'STOPPED') {
    return res.status(400).json({ error: 'Server must be stopped before restoring saves' });
  }

  try {
    addLog(`Restoring backup: ${filename}...`, 'info');
    const savesPath = path.join(serverDataPath, 'Saves');
    
    // Clear current saves first to prevent merge clashes
    if (existsSync(savesPath)) {
      await fs.rm(savesPath, { recursive: true, force: true });
    }
    await fs.mkdir(savesPath, { recursive: true });

    const zip = new AdmZip(zipFilePath);
    zip.extractAllTo(savesPath, true);

    addLog(`Backup restored successfully: ${filename}`, 'info');
    res.json({ success: true });
  } catch (err) {
    addLog(`Failed to restore backup: ${err.message}`, 'stderr');
    res.status(500).json({ error: err.message });
  }
});

// 12. DELETE BACKUP (admin only)
app.delete('/api/backups/:filename', requireAdmin, async (req, res) => {
  const { filename } = req.params;
  const filePath = path.join(backupsPath, filename);
  if (!existsSync(filePath)) return res.status(404).json({ error: 'Backup not found' });

  try {
    await fs.unlink(filePath);
    addLog(`Deleted backup file: ${filename}`, 'info');
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 13. SAVE MANAGER CONFIGURATION (admin only)
app.post('/api/manager-config', requireAdmin, async (req, res) => {
  try {
    const updates = req.body;
    if (updates.autoBackupEnabled !== undefined) config.autoBackupEnabled = updates.autoBackupEnabled;
    if (updates.autoBackupIntervalHours !== undefined) config.autoBackupIntervalHours = parseFloat(updates.autoBackupIntervalHours);
    if (updates.autoBackupRetentionCount !== undefined) config.autoBackupRetentionCount = parseInt(updates.autoBackupRetentionCount);
    
    await saveConfig();
    startAutoBackupSchedule(); // adjust backup timer
    res.json({ success: true, config });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 14. GET SCENARIOS LIST (admin only)
app.get('/api/scenarios', requireAdmin, async (req, res) => {
  try {
    const worldsPath = path.join(serverFilesPath, 'Content', 'CustomWorlds');
    if (!existsSync(worldsPath)) {
      return res.json({ scenarios: [] });
    }
    const files = await fs.readdir(worldsPath);
    const scenarios = [];
    for (const file of files) {
      const stat = await fs.stat(path.join(worldsPath, file));
      if (stat.isDirectory()) {
        scenarios.push(file);
      }
    }
    res.json({ scenarios });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 15. CREATE NEW WORLD (admin only)
app.post('/api/worlds/create', requireAdmin, async (req, res) => {
  if (serverStatus !== 'STOPPED') {
    return res.status(400).json({ error: 'Server must be stopped to create a new world' });
  }

  const { worldName, scenarioName } = req.body;
  if (!worldName || !scenarioName) {
    return res.status(400).json({ error: 'worldName and scenarioName are required' });
  }

  try {
    const mainCfg = await readSedsConfig();
    if (!mainCfg) return res.status(404).json({ error: 'Config file not found' });

    const d = mainCfg.MyConfigDedicated;
    const scenarioLinuxPath = path.join(serverFilesPath, 'Content', 'CustomWorlds', scenarioName);
    const wineScenarioPath = await getWinePath(scenarioLinuxPath);

    d.WorldName = worldName;
    d.LoadWorld = ''; // clear loadWorld to trigger generation
    d.PremadeCheckpointPath = wineScenarioPath;

    await writeSedsConfig(mainCfg);
    addLog(`Configured server to generate new world '${worldName}' using scenario '${scenarioName}' on next launch.`, 'info');
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 16. ACTIVATE EXISTING WORLD (admin only)
app.post('/api/worlds/activate', requireAdmin, async (req, res) => {
  if (serverStatus !== 'STOPPED') {
    return res.status(400).json({ error: 'Server must be stopped to load an existing world' });
  }

  const { worldName } = req.body;
  if (!worldName) {
    return res.status(400).json({ error: 'worldName is required' });
  }

  try {
    const mainCfg = await readSedsConfig();
    if (!mainCfg) return res.status(404).json({ error: 'Config file not found' });

    const d = mainCfg.MyConfigDedicated;
    const worldLinuxPath = path.join(serverDataPath, 'Saves', worldName);
    const wineWorldPath = await getWinePath(worldLinuxPath);

    d.WorldName = worldName;
    d.LoadWorld = wineWorldPath;
    d.PremadeCheckpointPath = ''; // clear starting scenario since we are loading an existing world

    await writeSedsConfig(mainCfg);
    addLog(`Activated existing world '${worldName}' for next launch.`, 'info');
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Start application
app.listen(PORT, '0.0.0.0', () => {
  console.log(`========================================================`);
  console.log(` Space Engineers Server Manager is running on port ${PORT}`);
  console.log(` Web UI: http://localhost:${PORT}`);
  console.log(` Wine Prefix: ${winePrefixPath}`);
  console.log(` Server Files: ${serverFilesPath}`);
  console.log(` Server Data: ${serverDataPath}`);
  console.log(` Backups: ${backupsPath}`);
  console.log(`========================================================`);
  
  if (config.autoUpdateOnStart) {
    updateGameServer();
  }
});
