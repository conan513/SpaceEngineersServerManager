// Space Engineers Dedicated Server Manager - Frontend JavaScript Logic

class ServerManagerApp {
  constructor() {
    this.status = 'STOPPED';
    this.uptime = 0;
    this.activeWorld = '';
    this.worlds = [];
    this.backups = [];
    this.mods = [];
    this.logEventSource = null;
    this.uptimeInterval = null;
    this.statusInterval = null;

    this.init();
  }

  init() {
    this.setupEventListeners();
    this.switchTab('dashboard');
    this.startStatusPolling();
    this.connectLogStream();
    this.loadConfig();
    this.loadBackups();
    this.loadMods();
    this.loadScenarios();
  }

  // Show status popup notifications
  showNotification(text, type = 'info') {
    const notification = document.getElementById('notification');
    const notificationText = document.getElementById('notification-text');
    
    notificationText.textContent = text;
    notification.className = 'notification';
    if (type === 'error') {
      notification.style.borderColor = 'var(--danger)';
    } else if (type === 'success') {
      notification.style.borderColor = 'var(--success)';
    } else {
      notification.style.borderColor = 'var(--primary)';
    }
    
    notification.classList.remove('hidden');
    
    setTimeout(() => {
      notification.classList.add('hidden');
    }, 4000);
  }

  // Sidebar navigation panel switching
  switchTab(tabId) {
    // Update active nav button
    document.querySelectorAll('.nav-btn').forEach(btn => {
      btn.classList.toggle('active', btn.getAttribute('data-tab') === tabId);
    });

    // Update active panel
    document.querySelectorAll('.tab-panel').forEach(panel => {
      panel.classList.toggle('active', panel.id === `tab-${tabId}`);
    });

    // Update headers
    const titleMap = {
      dashboard: { title: 'System Dashboard', subtitle: 'Real-time server monitoring and control' },
      settings: { title: 'Game Configurations', subtitle: 'Modify server property lists and parameters' },
      mods: { title: 'Steam Mods Manager', subtitle: 'Configure active Steam Workshop mods' },
      backups: { title: 'Saves & Backups', subtitle: 'Archive and restore worlds' },
      console: { title: 'Dedicated Server Console', subtitle: 'Direct wine stderr/stdout console log stream' }
    };

    const header = titleMap[tabId] || titleMap.dashboard;
    document.getElementById('current-tab-title').textContent = header.title;
    document.getElementById('current-tab-subtitle').textContent = header.subtitle;

    // Trigger tab specific loads
    if (tabId === 'settings') {
      this.loadConfig();
    } else if (tabId === 'backups') {
      this.loadBackups();
    } else if (tabId === 'mods') {
      this.loadMods();
    }
  }

  setupEventListeners() {
    // Navigation buttons
    document.querySelectorAll('.nav-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        this.switchTab(btn.getAttribute('data-tab'));
      });
    });

    // Control buttons
    document.getElementById('btn-start').addEventListener('click', () => this.sendControlAction('start'));
    document.getElementById('btn-stop').addEventListener('click', () => this.sendControlAction('stop'));
    document.getElementById('btn-restart').addEventListener('click', () => this.sendControlAction('restart'));
    document.getElementById('btn-update').addEventListener('click', () => {
      if (confirm('Are you sure you want to stop the server and run SteamCMD update?')) {
        this.sendControlAction('update');
      }
    });

    // Config form submission
    document.getElementById('config-form').addEventListener('submit', (e) => {
      e.preventDefault();
      this.saveConfig();
    });

    // Mods Manager controls
    document.getElementById('btn-add-mod').addEventListener('click', () => this.addMod());
    document.getElementById('new-mod-id').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); this.addMod(); }
    });
    document.getElementById('btn-save-mods').addEventListener('click', () => this.saveMods());

    // Backups Manager controls
    document.getElementById('btn-create-backup').addEventListener('click', () => this.createBackup());
    document.getElementById('btn-clear-console').addEventListener('click', () => {
      document.getElementById('full-console').innerHTML = '<div class="console-line system">[SYSTEM] Console cleared.</div>';
    });
    
    document.getElementById('btn-download-logs').addEventListener('click', () => {
      window.open('/api/logs/full', '_blank');
    });

    // World Creator form
    document.getElementById('create-world-form').addEventListener('submit', (e) => {
      e.preventDefault();
      this.createWorld();
    });
  }

  // Periodic status checking (every 3 seconds)
  startStatusPolling() {
    this.fetchStatus();
    this.statusInterval = setInterval(() => this.fetchStatus(), 3000);
  }

  async fetchStatus() {
    try {
      const response = await fetch('/api/status');
      if (!response.ok) throw new Error('Status query failed');
      const data = await response.json();

      this.updateUIVariables(data);
    } catch (err) {
      console.error('Error fetching server status:', err);
      document.getElementById('quick-status').textContent = 'OFFLINE';
      document.getElementById('quick-status').className = 'stat-value status-stopped';
    }
  }

  updateUIVariables(data) {
    this.status = data.status;
    this.activeWorld = data.activeWorld;
    this.worlds = data.worlds;

    // 1. Update status texts
    const statusEl = document.getElementById('quick-status');
    statusEl.textContent = this.status;
    statusEl.className = 'stat-value ' + this.getStatusClass(this.status);

    const consoleDot = document.getElementById('console-status-indicator');
    consoleDot.className = 'console-indicator ' + this.getConsoleDotClass(this.status);

    // 2. Control buttons disabled state
    document.getElementById('btn-start').disabled = (this.status !== 'STOPPED');
    document.getElementById('btn-stop').disabled = (this.status !== 'RUNNING' && this.status !== 'STARTING');
    document.getElementById('btn-restart').disabled = (this.status !== 'RUNNING');
    document.getElementById('btn-update').disabled = (this.status !== 'STOPPED');

    // 3. Resource stats
    document.getElementById('quick-cpu').textContent = `${data.cpu}%`;
    document.getElementById('quick-mem').textContent = `${data.memory} MB`;
    
    // Update SVG monitoring rings
    // CPU ring
    const cpuRing = document.getElementById('cpu-ring');
    const cpuVal = Math.min(100, Math.max(0, parseFloat(data.cpu) || 0));
    cpuRing.setAttribute('stroke-dasharray', `${cpuVal}, 100`);
    document.getElementById('cpu-ring-text').textContent = `${Math.round(cpuVal)}%`;

    // Memory ring (assume 8GB max for wine prefix representation)
    const memRing = document.getElementById('mem-ring');
    const memPercent = Math.min(100, ((parseInt(data.memory) || 0) / 8192) * 100);
    memRing.setAttribute('stroke-dasharray', `${memPercent.toFixed(0)}, 100`);
    document.getElementById('mem-ring-text').textContent = `${memPercent.toFixed(0)}%`;

    // Active world text
    document.getElementById('active-world-name').textContent = this.activeWorld;

    // 4. Uptime timer
    if (this.status === 'RUNNING' || this.status === 'STARTING') {
      this.uptime = data.uptime;
      this.startUptimeTicker();
    } else {
      this.stopUptimeTicker();
      document.getElementById('quick-uptime').textContent = '00:00:00';
    }
  }

  getStatusClass(status) {
    switch(status) {
      case 'RUNNING': return 'status-running';
      case 'STARTING': return 'status-starting';
      case 'STOPPED': return 'status-stopped';
      case 'STOPPING': return 'status-stopped';
      case 'UPDATING': return 'status-updating';
      default: return 'status-stopped';
    }
  }

  getConsoleDotClass(status) {
    switch(status) {
      case 'RUNNING': return 'status-dot-running';
      case 'STARTING': return 'status-dot-starting';
      case 'STOPPED': return 'status-dot-stopped';
      case 'STOPPING': return 'status-dot-stopped';
      case 'UPDATING': return 'status-dot-updating';
      default: return 'status-dot-stopped';
    }
  }

  startUptimeTicker() {
    if (this.uptimeInterval) return;
    this.uptimeInterval = setInterval(() => {
      this.uptime++;
      document.getElementById('quick-uptime').textContent = this.formatTime(this.uptime);
    }, 1000);
  }

  stopUptimeTicker() {
    if (this.uptimeInterval) {
      clearInterval(this.uptimeInterval);
      this.uptimeInterval = null;
    }
  }

  formatTime(seconds) {
    const h = Math.floor(seconds / 3600).toString().padStart(2, '0');
    const m = Math.floor((seconds % 3600) / 60).toString().padStart(2, '0');
    const s = Math.floor(seconds % 60).toString().padStart(2, '0');
    return `${h}:${m}:${s}`;
  }

  // Trigger start/stop actions
  async sendControlAction(action) {
    try {
      const response = await fetch('/api/control', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action })
      });
      const data = await response.json();
      if (data.success) {
        this.showNotification(`Server command '${action}' sent successfully!`, 'success');
        this.fetchStatus();
      } else {
        throw new Error(data.error || 'Command failed');
      }
    } catch (err) {
      this.showNotification(`Failed to execute command: ${err.message}`, 'error');
    }
  }

  // SSE connection for live logs
  connectLogStream() {
    if (this.logEventSource) {
      this.logEventSource.close();
    }

    this.logEventSource = new EventSource('/api/logs/stream');

    this.logEventSource.onmessage = (event) => {
      const log = JSON.parse(event.data);
      this.appendConsoleLine(log);
    };

    this.logEventSource.onerror = (err) => {
      console.warn('SSE log connection lost. Reconnecting...');
      setTimeout(() => this.connectLogStream(), 5000);
    };
  }

  appendConsoleLine(log) {
    const miniConsole = document.getElementById('mini-console');
    const fullConsole = document.getElementById('full-console');
    
    // Format timestamp
    const time = log.timestamp ? log.timestamp.substring(11, 19) : new Date().toLocaleTimeString();
    const cleanText = log.text.replace(/[\u001b\u009b][[()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><]/g, ''); // strip bash colors
    
    const lineHtml = `<div class="console-line ${log.type}">[${time}] ${cleanText}</div>`;

    // Append to mini console (dashboard tab)
    const isMiniScrolled = miniConsole.scrollHeight - miniConsole.clientHeight <= miniConsole.scrollTop + 50;
    miniConsole.insertAdjacentHTML('beforeend', lineHtml);
    if (isMiniScrolled) {
      miniConsole.scrollTop = miniConsole.scrollHeight;
    }

    // Append to full console (logs tab)
    const isFullScrolled = fullConsole.scrollHeight - fullConsole.clientHeight <= fullConsole.scrollTop + 50;
    fullConsole.insertAdjacentHTML('beforeend', lineHtml);
    if (isFullScrolled) {
      fullConsole.scrollTop = fullConsole.scrollHeight;
    }
  }

  // CONFIGURATION tab loader & saver
  async loadConfig() {
    try {
      const response = await fetch('/api/config');
      if (!response.ok) throw new Error('Could not load game configuration');
      const data = await response.json();

      // Populate config forms
      document.getElementById('cfg-serverName').value = data.serverName;
      document.getElementById('cfg-port').value = data.port;
      document.getElementById('cfg-ip').value = data.ip;
      document.getElementById('cfg-gameMode').value = data.gameMode;
      document.getElementById('cfg-maxPlayers').value = data.maxPlayers;
      document.getElementById('cfg-inventorySizeMultiplier').value = data.inventorySizeMultiplier;
      document.getElementById('cfg-assemblerSpeedMultiplier').value = data.assemblerSpeedMultiplier;
      document.getElementById('cfg-refinerySpeedMultiplier').value = data.refinerySpeedMultiplier;
      document.getElementById('cfg-welderSpeedMultiplier').value = data.welderSpeedMultiplier;
      document.getElementById('cfg-grinderSpeedMultiplier').value = data.grinderSpeedMultiplier;
      document.getElementById('cfg-autoSaveInMinutes').value = data.autoSaveInMinutes;
      document.getElementById('cfg-enableIngameScripts').checked = data.enableIngameScripts;
      document.getElementById('cfg-viewDistance').value = data.viewDistance;
      
      // Load world select dropdown options
      const worldSelect = document.getElementById('cfg-worldName');
      worldSelect.innerHTML = '';
      
      // Make sure there is always at least the selected world or a default
      const worldsList = this.worlds.length > 0 ? this.worlds : [data.worldName];
      if (!worldsList.includes(data.worldName)) {
        worldsList.push(data.worldName);
      }
      
      worldsList.forEach(world => {
        const opt = document.createElement('option');
        opt.value = world;
        opt.textContent = world;
        opt.selected = (world === data.worldName);
        worldSelect.appendChild(opt);
      });

      // Load manager settings
      const statusRes = await fetch('/api/status');
      const statusData = await statusRes.json();
      const mgrCfg = statusData.config;

      document.getElementById('mgr-autoBackupEnabled').checked = mgrCfg.autoBackupEnabled;
      document.getElementById('mgr-autoBackupIntervalHours').value = mgrCfg.autoBackupIntervalHours;
      document.getElementById('mgr-autoBackupRetentionCount').value = mgrCfg.autoBackupRetentionCount;

    } catch (err) {
      console.error(err);
      this.showNotification(`Error loading configs: ${err.message}`, 'error');
    }
  }

  async saveConfig() {
    const statusMsg = document.getElementById('config-save-status');
    statusMsg.textContent = 'Saving configurations...';
    statusMsg.className = 'status-msg';

    try {
      // 1. Save SEDS configurations
      const sedsUpdates = {
        serverName: document.getElementById('cfg-serverName').value,
        port: parseInt(document.getElementById('cfg-port').value),
        ip: document.getElementById('cfg-ip').value,
        worldName: document.getElementById('cfg-worldName').value,
        pauseGameWhenEmpty: document.getElementById('cfg-pauseGameWhenEmpty').checked,
        ignoreLastSession: document.getElementById('cfg-ignoreLastSession').checked,
        
        gameMode: document.getElementById('cfg-gameMode').value,
        maxPlayers: parseInt(document.getElementById('cfg-maxPlayers').value),
        inventorySizeMultiplier: parseFloat(document.getElementById('cfg-inventorySizeMultiplier').value),
        assemblerSpeedMultiplier: parseFloat(document.getElementById('cfg-assemblerSpeedMultiplier').value),
        refinerySpeedMultiplier: parseFloat(document.getElementById('cfg-refinerySpeedMultiplier').value),
        welderSpeedMultiplier: parseFloat(document.getElementById('cfg-welderSpeedMultiplier').value),
        grinderSpeedMultiplier: parseFloat(document.getElementById('cfg-grinderSpeedMultiplier').value),
        autoSaveInMinutes: parseInt(document.getElementById('cfg-autoSaveInMinutes').value),
        enableIngameScripts: document.getElementById('cfg-enableIngameScripts').checked,
        viewDistance: parseInt(document.getElementById('cfg-viewDistance').value)
      };

      const sedsRes = await fetch('/api/config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(sedsUpdates)
      });
      if (!sedsRes.ok) throw new Error('SE Dedicated config save failed');

      // 2. Save manager config
      const mgrUpdates = {
        autoBackupEnabled: document.getElementById('mgr-autoBackupEnabled').checked,
        autoBackupIntervalHours: parseFloat(document.getElementById('mgr-autoBackupIntervalHours').value),
        autoBackupRetentionCount: parseInt(document.getElementById('mgr-autoBackupRetentionCount').value)
      };

      const mgrRes = await fetch('/api/manager-config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(mgrUpdates)
      });
      if (!mgrRes.ok) throw new Error('Server Manager config save failed');

      statusMsg.textContent = 'Configurations saved successfully!';
      statusMsg.className = 'status-msg success';
      this.showNotification('Configurations saved and synced successfully!', 'success');
      
      // Update local values
      this.fetchStatus();
    } catch (err) {
      statusMsg.textContent = `Save failed: ${err.message}`;
      statusMsg.className = 'status-msg error';
      this.showNotification(`Config save failed: ${err.message}`, 'error');
    }
  }

  // MODS tab loader & builder
  async loadMods() {
    try {
      const response = await fetch('/api/mods');
      if (!response.ok) throw new Error('Could not load mod lists');
      const data = await response.json();
      this.mods = data.mods || [];

      this.renderModsTable();
    } catch (err) {
      console.error(err);
      this.showNotification(`Error loading mods: ${err.message}`, 'error');
    }
  }

  renderModsTable() {
    const tbody = document.getElementById('mods-table-body');
    tbody.innerHTML = '';

    if (this.mods.length === 0) {
      tbody.innerHTML = `<tr><td colspan="4" class="text-center">No mods configured. Use the fields above to add Steam workshop mods!</td></tr>`;
      return;
    }

    this.mods.forEach((mod, index) => {
      const tr = document.createElement('tr');
      tr.innerHTML = `
        <td><strong>${mod.title || 'Loading Name...'}</strong></td>
        <td><code>${mod.id}</code></td>
        <td>
          <a href="https://steamcommunity.com/sharedfiles/filedetails/?id=${mod.id}" target="_blank" class="table-link">
            Workshop Link 🔗
          </a>
        </td>
        <td class="actions-col">
          <button class="btn btn-sm btn-danger btn-remove-mod" data-index="${index}">Delete</button>
        </td>
      `;
      tbody.appendChild(tr);
    });

    // Bind remove buttons
    document.querySelectorAll('.btn-remove-mod').forEach(btn => {
      btn.addEventListener('click', (e) => {
        const index = parseInt(e.target.getAttribute('data-index'));
        this.mods.splice(index, 1);
        this.renderModsTable();
      });
    });
  }

  async addMod() {
    const input = document.getElementById('new-mod-id');
    const button = document.getElementById('btn-add-mod');
    const statusEl = document.getElementById('mod-add-status');
    const modId = input.value.trim();
    if (!modId) return;

    if (this.mods.some(m => m.id === modId)) {
      this.showNotification('This mod is already in the list!', 'warning');
      return;
    }

    input.disabled = true;
    button.disabled = true;
    const originalText = button.innerHTML;
    button.innerHTML = 'Resolving...';
    statusEl.textContent = `🔍 Fetching mod info and dependency tree from Steam Workshop...`;
    statusEl.className = 'status-msg';

    try {
      const response = await fetch('/api/mods/resolve', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ modId })
      });
      if (!response.ok) throw new Error('Steam details query failed');
      const data = await response.json();
      const resolvedMods = data.mods || []; // Array of { id, title }

      if (resolvedMods.length === 0) {
        throw new Error('Workshop ID not found or item does not exist');
      }

      let addedCount = 0;
      const addedNames = [];
      resolvedMods.forEach(rm => {
        if (!this.mods.some(m => m.id === rm.id)) {
          this.mods.push(rm);
          addedCount++;
          addedNames.push(rm.title || rm.id);
        }
      });

      const mainModName = resolvedMods[0]?.title || modId;
      if (addedCount > 1) {
        const depList = addedNames.slice(1).join(', ');
        statusEl.textContent = `✅ Added '${mainModName}' + ${addedCount - 1} dependencies: ${depList}`;
        statusEl.className = 'status-msg success';
        this.showNotification(`Added mod '${mainModName}' and ${addedCount - 1} missing dependencies!`, 'success');
      } else if (addedCount === 1) {
        statusEl.textContent = `✅ Added '${mainModName}' (no dependencies found)`;
        statusEl.className = 'status-msg success';
        this.showNotification(`Added mod '${mainModName}'!`, 'success');
      } else {
        statusEl.textContent = `ℹ️ Mod '${mainModName}' and all its dependencies are already in the list.`;
        statusEl.className = 'status-msg';
        this.showNotification(`Mod '${mainModName}' is already fully added.`, 'info');
      }

      input.value = '';
      this.renderModsTable();
    } catch (err) {
      statusEl.textContent = `❌ Error: ${err.message}`;
      statusEl.className = 'status-msg error';
      this.showNotification(`Failed to resolve dependencies: ${err.message}`, 'error');
      console.error(err);
    } finally {
      input.disabled = false;
      button.disabled = false;
      button.innerHTML = originalText;
    }
  }

  async saveMods() {
    const statusMsg = document.getElementById('mods-save-status');
    statusMsg.textContent = 'Saving mod list...';
    statusMsg.className = 'status-msg';

    try {
      const response = await fetch('/api/mods', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mods: this.mods })
      });
      if (!response.ok) throw new Error('Mods save failed');

      statusMsg.textContent = 'Mods list saved and synced!';
      statusMsg.className = 'status-msg success';
      this.showNotification('Mods configuration updated successfully!', 'success');
    } catch (err) {
      statusMsg.textContent = `Save failed: ${err.message}`;
      statusMsg.className = 'status-msg error';
      this.showNotification(`Failed to save mods: ${err.message}`, 'error');
    }
  }

  // BACKUPS tab loader & actions
  async loadBackups() {
    try {
      // 1. Load Backup Archives list
      const backupRes = await fetch('/api/backups');
      if (!backupRes.ok) throw new Error('Could not fetch backups list');
      const backupData = await backupRes.json();
      this.backups = backupData.backups || [];
      this.renderBackupsTable();

      // 2. Load World folders list
      const statusRes = await fetch('/api/status');
      const statusData = await statusRes.json();
      this.renderWorldsTable(statusData.worlds, statusData.activeWorld);
    } catch (err) {
      console.error(err);
      this.showNotification(`Error loading backups: ${err.message}`, 'error');
    }
  }

  renderWorldsTable(worlds, activeWorld) {
    const tbody = document.getElementById('worlds-table-body');
    tbody.innerHTML = '';

    if (!worlds || worlds.length === 0) {
      tbody.innerHTML = `<tr><td colspan="3" class="text-center">No world directories found. Start the server to generate a default world.</td></tr>`;
      return;
    }

    worlds.forEach(world => {
      const isActive = world === activeWorld;
      const tr = document.createElement('tr');
      tr.innerHTML = `
        <td><strong>${world}</strong></td>
        <td>
          <span class="${isActive ? 'status-running' : 'status-stopped'}">
            ${isActive ? '● Active' : '○ Dormant'}
          </span>
        </td>
        <td class="actions-col">
          ${isActive 
            ? '<span class="status-msg success">Currently Loaded</span>' 
            : `<button class="btn btn-sm btn-outline btn-activate-world" data-world="${world}">Activate</button>`
          }
        </td>
      `;
      tbody.appendChild(tr);
    });

    // Bind activate buttons
    document.querySelectorAll('.btn-activate-world').forEach(btn => {
      btn.addEventListener('click', (e) => {
        const world = e.target.getAttribute('data-world');
        this.activateWorld(world);
      });
    });
  }

  async loadScenarios() {
    try {
      const response = await fetch('/api/scenarios');
      if (!response.ok) throw new Error('Failed to load starting scenarios');
      const data = await response.json();
      
      const select = document.getElementById('new-world-scenario');
      select.innerHTML = '';
      
      if (data.scenarios && data.scenarios.length > 0) {
        data.scenarios.forEach(sc => {
          const opt = document.createElement('option');
          opt.value = sc;
          opt.textContent = sc;
          select.appendChild(opt);
        });
      } else {
        const opt = document.createElement('option');
        opt.value = "Star System";
        opt.textContent = "Star System (Default)";
        select.appendChild(opt);
      }
    } catch (err) {
      console.error('Error loading scenarios:', err);
    }
  }

  async activateWorld(worldName) {
    if (this.status !== 'STOPPED') {
      this.showNotification('You must STOP the server before changing worlds!', 'error');
      alert('Error: Please stop the server before activating a dormant world.');
      return;
    }

    try {
      this.showNotification(`Activating world: ${worldName}...`, 'info');
      const response = await fetch('/api/worlds/activate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ worldName })
      });
      const data = await response.json();
      if (data.success) {
        this.showNotification(`World '${worldName}' activated!`, 'success');
        this.fetchStatus();
        this.loadConfig();
        this.loadBackups();
      } else {
        throw new Error(data.error || 'Activation failed');
      }
    } catch (err) {
      this.showNotification(`Failed to activate world: ${err.message}`, 'error');
    }
  }

  async createWorld() {
    if (this.status !== 'STOPPED') {
      this.showNotification('You must STOP the server before generating a new world!', 'error');
      alert('Error: Please stop the server before configuring a new world.');
      return;
    }

    const nameInput = document.getElementById('new-world-name');
    const worldName = nameInput.value.trim();
    const scenarioName = document.getElementById('new-world-scenario').value;

    if (!worldName) return;

    try {
      this.showNotification(`Configuring new world '${worldName}'...`, 'info');
      const response = await fetch('/api/worlds/create', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ worldName, scenarioName })
      });
      const data = await response.json();
      if (data.success) {
        this.showNotification(`World configured! Click Start Server to generate it.`, 'success');
        nameInput.value = '';
        this.fetchStatus();
        this.loadConfig();
        this.loadBackups();
      } else {
        throw new Error(data.error || 'World creation failed');
      }
    } catch (err) {
      this.showNotification(`Failed to configure world: ${err.message}`, 'error');
    }
  }

  renderBackupsTable() {
    const tbody = document.getElementById('backups-table-body');
    tbody.innerHTML = '';

    if (this.backups.length === 0) {
      tbody.innerHTML = `<tr><td colspan="4" class="text-center">No backup zip archives found. Click 'Backup Current Saves' to create one!</td></tr>`;
      return;
    }

    this.backups.forEach(backup => {
      const sizeMb = (backup.size / (1024 * 1024)).toFixed(2);
      const date = new Date(backup.createdAt).toLocaleString();
      
      const tr = document.createElement('tr');
      tr.innerHTML = `
        <td><code>${backup.filename}</code></td>
        <td>${sizeMb} MB</td>
        <td>${date}</td>
        <td class="actions-col actions-cell">
          <button class="btn btn-sm btn-outline btn-restore-backup" data-file="${backup.filename}">Restore</button>
          <button class="btn btn-sm btn-danger btn-delete-backup" data-file="${backup.filename}">Delete</button>
        </td>
      `;
      tbody.appendChild(tr);
    });

    // Bind action buttons
    document.querySelectorAll('.btn-restore-backup').forEach(btn => {
      btn.addEventListener('click', (e) => {
        const file = e.target.getAttribute('data-file');
        this.restoreBackup(file);
      });
    });

    document.querySelectorAll('.btn-delete-backup').forEach(btn => {
      btn.addEventListener('click', (e) => {
        const file = e.target.getAttribute('data-file');
        this.deleteBackup(file);
      });
    });
  }

  async createBackup() {
    this.showNotification('Triggering server saves backup...', 'info');
    try {
      const response = await fetch('/api/backups/create', { method: 'POST' });
      if (!response.ok) throw new Error('Backup creation failed');
      const data = await response.json();
      
      this.showNotification(`Backup archive created: ${data.filename}`, 'success');
      this.loadBackups();
    } catch (err) {
      this.showNotification(`Failed to create backup: ${err.message}`, 'error');
    }
  }

  async restoreBackup(filename) {
    if (this.status !== 'STOPPED') {
      this.showNotification('You must STOP the server before restoring a save archive!', 'error');
      alert('Error: Space Engineers must be offline before files can be modified.');
      return;
    }

    if (confirm(`CRITICAL ACTION WARNING:\nAre you sure you want to restore the backup: ${filename}?\nThis will completely replace all current world saves and sbc files.`)) {
      this.showNotification(`Restoring saves archive: ${filename}...`, 'info');
      try {
        const response = await fetch('/api/backups/restore', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ filename })
        });
        const data = await response.json();
        if (data.success) {
          this.showNotification('Saves successfully restored!', 'success');
          this.loadBackups();
        } else {
          throw new Error(data.error || 'Restore failed');
        }
      } catch (err) {
        this.showNotification(`Restore failed: ${err.message}`, 'error');
      }
    }
  }

  async deleteBackup(filename) {
    if (confirm(`Are you sure you want to permanently delete the backup archive: ${filename}?`)) {
      try {
        const response = await fetch(`/api/backups/${filename}`, { method: 'DELETE' });
        if (!response.ok) throw new Error('Deletion failed');
        
        this.showNotification('Backup successfully deleted.', 'success');
        this.loadBackups();
      } catch (err) {
        this.showNotification(`Failed to delete backup: ${err.message}`, 'error');
      }
    }
  }
}

// Instantiate application on load
window.addEventListener('DOMContentLoaded', () => {
  window.app = new ServerManagerApp();
});
