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
  autoUpdateOnStart: false
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

// Sync mods from .cfg into the active world's Sandbox_config.sbc before server start
async function syncModsToActiveWorld() {
  try {
    // 1. Read mod IDs from the dedicated server config
    let modIds = [];
    if (existsSync(CONFIG_FILE_PATH)) {
      const raw = await fs.readFile(CONFIG_FILE_PATH, 'utf-8');
      const modsBlockMatch = raw.match(/<Mods[\s\S]*?<\/Mods>/i);
      if (modsBlockMatch) {
        const modsBlock = modsBlockMatch[0];
        const newIds = [...modsBlock.matchAll(/<PublishedItemId>(\d+)<\/PublishedItemId>/gi)].map(m => m[1]);
        const oldIds = [...modsBlock.matchAll(/<Id>(\d+)<\/Id>/gi)].map(m => m[1]);
        modIds = newIds.length > 0 ? newIds : oldIds;
      }
    }

    if (modIds.length === 0) {
      addLog('No mods configured, skipping mod sync.', 'info');
      return;
    }

    // 2. Find the active world's Sandbox_config.sbc
    const sandbox = await getActiveWorldSandboxConfig();
    if (!sandbox) {
      addLog('No active world Sandbox_config.sbc found — mods cannot be synced yet.', 'warning');
      return;
    }

    // 3. Write mods into Sandbox_config.sbc
    const updated = await writeModsToXmlFile(sandbox.path, modIds);
    if (updated) {
      addLog(`✅ Synced ${modIds.length} mod(s) into ${sandbox.path}`, 'info');
    }
  } catch (err) {
    addLog(`Warning: mod sync failed — ${err.message}`, 'warning');
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
    path.join(serverDataPath, 'SpaceEngineersDedicated.log'),
    path.join(serverDataPath, 'Logs', 'SpaceEngineersDedicated.log'),
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

// Build the <Mods>...</Mods> XML block from a list of mod IDs
function buildModsXmlBlock(modIds) {
  if (!modIds || modIds.length === 0) {
    return '<Mods />';
  }
  const items = modIds.map(id =>
    `      <MyObjectBuilder_WorkshopItem>\n        <PublishedItemId>${id}</PublishedItemId>\n        <PublishedFileId>${id}</PublishedFileId>\n        <Title />\n        <Enabled>true</Enabled>\n      </MyObjectBuilder_WorkshopItem>`
  ).join('\n');
  return `<Mods>\n${items}\n    </Mods>`;
}

// Write mods into a raw XML file via regex block replacement (preserves namespaces)
async function writeModsToXmlFile(filePath, modIds) {
  if (!existsSync(filePath)) return false;
  let content = await fs.readFile(filePath, 'utf-8');

  const modsBlock = buildModsXmlBlock(modIds);

  // Single regex: matches <Mods /> OR <Mods>...</Mods> (including multiline)
  const modsRegex = /<Mods\s*\/>|<Mods[\s\S]*?<\/Mods>/i;

  if (modsRegex.test(content)) {
    content = content.replace(modsRegex, modsBlock);
  } else {
    // No Mods tag at all — insert before closing root tag
    content = content.replace(/(<\/[A-Za-z:]+>\s*)$/, `    ${modsBlock}\n$1`);
  }

  await fs.writeFile(filePath, content, 'utf-8');
  return true;
}

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

// Get sandbox config of active world if available
async function getActiveWorldSandboxConfig() {
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

    const sbcPath = path.join(serverDataPath, 'Saves', worldFolder, 'Sandbox_config.sbc');
    if (existsSync(sbcPath)) {
      const content = await fs.readFile(sbcPath, 'utf-8');
      const parser = new xml2js.Parser({ explicitArray: false });
      return {
        path: sbcPath,
        data: await parser.parseStringPromise(content)
      };
    }
  } catch (err) {
    console.warn('Sandbox_config.sbc not found or could not be parsed:', err.message);
  }
  return null;
}

// Express app setup
const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// 1. GET STATUS
app.get('/api/status', async (req, res) => {
  let activeWorld = 'None';
  try {
    const mainCfg = await readSedsConfig();
    if (mainCfg) {
      activeWorld = mainCfg.MyConfigDedicated?.WorldName || 'Default World';
    }
  } catch(e) {}

  let worlds = [];
  try {
    const savesPath = path.join(serverDataPath, 'Saves');
    if (existsSync(savesPath)) {
      const files = await fs.readdir(savesPath);
      for (const file of files) {
        const stat = await fs.stat(path.join(savesPath, file));
        if (stat.isDirectory()) {
          worlds.push(file);
        }
      }
    }
  } catch(e) {}

  res.json({
    status: serverStatus,
    uptime: serverUptimeStart ? Math.floor((Date.now() - serverUptimeStart) / 1000) : 0,
    cpu: resourceUsage.cpu,
    memory: resourceUsage.memory,
    activeWorld,
    worlds,
    config
  });
});

// 2. SERVER CONTROL ACTIONS
app.post('/api/control', async (req, res) => {
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

// 3. GET FULL / REALTIME LOGS STREAM
app.get('/api/logs/stream', (req, res) => {
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

// 4. GET SYSTEM / GAME LOGS
app.get('/api/logs/full', async (req, res) => {
  try {
    const logFilePath = path.join(serverDataPath, 'SpaceEngineersDedicated.log');
    if (existsSync(logFilePath)) {
      const data = await fs.readFile(logFilePath, 'utf-8');
      const lines = data.split('\n').slice(-1000).join('\n'); // Last 1000 lines
      return res.send(lines);
    }
  } catch(e) {}
  res.send(logHistory.map(l => `[${l.type}] ${l.text}`).join('\n'));
});

// 5. GET CONFIGURATIONS
app.get('/api/config', async (req, res) => {
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
      viewDistance: parseInt(settings.ViewDistance) || 15000
    };

    res.json(responseData);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 6. UPDATE CONFIGURATIONS
app.post('/api/config', async (req, res) => {
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
    if (updates.viewDistance !== undefined) s.ViewDistance = updates.viewDistance.toString();

    await writeSedsConfig(mainCfg);

    // Sync updates to Sandbox_config.sbc of current world if it exists
    const sandbox = await getActiveWorldSandboxConfig();
    if (sandbox) {
      const sbc = sandbox.data;
      if (sbc && sbc.MySandboxGameConfig && sbc.MySandboxGameConfig.Settings) {
        const ws = sbc.MySandboxGameConfig.Settings;
        if (updates.gameMode !== undefined) ws.GameMode = updates.gameMode;
        if (updates.maxPlayers !== undefined) ws.MaxPlayers = updates.maxPlayers.toString();
        if (updates.inventorySizeMultiplier !== undefined) ws.InventorySizeMultiplier = updates.inventorySizeMultiplier.toString();
        if (updates.assemblerSpeedMultiplier !== undefined) ws.AssemblerSpeedMultiplier = updates.assemblerSpeedMultiplier.toString();
        if (updates.assemblerEfficiencyMultiplier !== undefined) ws.AssemblerEfficiencyMultiplier = updates.assemblerEfficiencyMultiplier.toString();
        if (updates.refinerySpeedMultiplier !== undefined) ws.RefinerySpeedMultiplier = updates.refinerySpeedMultiplier.toString();
        if (updates.welderSpeedMultiplier !== undefined) ws.WelderSpeedMultiplier = updates.welderSpeedMultiplier.toString();
        if (updates.grinderSpeedMultiplier !== undefined) ws.GrinderSpeedMultiplier = updates.grinderSpeedMultiplier.toString();
        if (updates.autoSaveInMinutes !== undefined) ws.AutoSaveInMinutes = updates.autoSaveInMinutes.toString();
        if (updates.enableIngameScripts !== undefined) ws.EnableIngameScripts = updates.enableIngameScripts.toString();
        if (updates.viewDistance !== undefined) ws.ViewDistance = updates.viewDistance.toString();

        const builder = new xml2js.Builder();
        const xml = builder.buildObject(sbc);
        await fs.writeFile(sandbox.path, xml, 'utf-8');
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

// 7. GET CONFIG MODS LIST (FETCHING NAMES FROM STEAM)
app.get('/api/mods', async (req, res) => {
  try {
    // Extract mod IDs directly from raw XML to avoid xml2js schema mismatches
    let modIds = [];

    if (existsSync(CONFIG_FILE_PATH)) {
      const raw = await fs.readFile(CONFIG_FILE_PATH, 'utf-8');

      // Extract <Mods>...</Mods> block first
      const modsBlockMatch = raw.match(/<Mods[\s\S]*?<\/Mods>/i);
      if (modsBlockMatch) {
        const modsBlock = modsBlockMatch[0];
        // Try new schema: <PublishedItemId> or <PublishedFileId>
        const newIds = [...modsBlock.matchAll(/<PublishedItemId>(\d+)<\/PublishedItemId>/gi)].map(m => m[1]);
        // Try old schema: <Id>
        const oldIds = [...modsBlock.matchAll(/<Id>(\d+)<\/Id>/gi)].map(m => m[1]);

        modIds = newIds.length > 0 ? newIds : oldIds;
      }
    }

    // Fetch names of mods from Steam
    const modsWithDetails = await getModDetails(modIds);
    res.json({ mods: modsWithDetails });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 8. UPDATE MODS LIST
app.post('/api/mods', async (req, res) => {
  try {
    const { mods } = req.body; // Array of IDs or array of objects { id, title }
    if (!Array.isArray(mods)) return res.status(400).json({ error: 'Mods must be an array' });

    // Normalize to simple list of string IDs
    const modIds = mods.map(m => (typeof m === 'object' ? String(m.id) : String(m)));

    // 1. Write to the dedicated server .cfg file
    const cfgUpdated = await writeModsToXmlFile(CONFIG_FILE_PATH, modIds);
    if (!cfgUpdated) {
      // Config file doesn't exist yet — try to create it with just mods
      addLog('SpaceEngineers-Dedicated.cfg not found, mods saved for next config write.', 'warning');
    } else {
      addLog(`Mods written to SpaceEngineers-Dedicated.cfg (${modIds.length} mods)`, 'info');
    }

    // 2. Sync to Sandbox_config.sbc of the active world
    const sandbox = await getActiveWorldSandboxConfig();
    if (sandbox) {
      const sandboxUpdated = await writeModsToXmlFile(sandbox.path, modIds);
      if (sandboxUpdated) {
        addLog(`Mods synchronized to active world Sandbox_config.sbc (${modIds.length} mods)`, 'info');
      }
    } else {
      addLog('No active world found — mods will be applied when a world is loaded.', 'warning');
    }

    res.json({ success: true, count: modIds.length });
  } catch (err) {
    addLog(`Error saving mods: ${err.message}`, 'stderr');
    res.status(500).json({ error: err.message });
  }
});

// 8b. RESOLVE MOD DEPENDENCIES
app.post('/api/mods/resolve', async (req, res) => {
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

// 9. GET BACKUPS
app.get('/api/backups', async (req, res) => {
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

// 10. CREATE BACKUP
app.post('/api/backups/create', async (req, res) => {
  const zipFilename = await triggerBackup('manual');
  if (zipFilename) {
    res.json({ success: true, filename: zipFilename });
  } else {
    res.status(500).json({ error: 'Failed to create backup' });
  }
});

// 11. RESTORE BACKUP
app.post('/api/backups/restore', async (req, res) => {
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

// 12. DELETE BACKUP
app.delete('/api/backups/:filename', async (req, res) => {
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

// 13. SAVE MANAGER CONFIGURATION (e.g. settings in config.json)
app.post('/api/manager-config', async (req, res) => {
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

// 14. GET SCENARIOS LIST
app.get('/api/scenarios', async (req, res) => {
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

// 15. CREATE NEW WORLD (CONFIG ONLY - SEDS GENERATES ON BOOT)
app.post('/api/worlds/create', async (req, res) => {
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

// 16. ACTIVATE EXISTING WORLD
app.post('/api/worlds/activate', async (req, res) => {
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
