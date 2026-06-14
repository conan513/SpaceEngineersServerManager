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

    // Auth state
    this.adminToken = localStorage.getItem('se_admin_token') || null;
    this.isAdmin = false;

    this.init();
  }

  async init() {
    this.setupAuthListeners();
    this.setupEventListeners();
    this.switchTab('serverinfo');
    this.startStatusPolling();

    // Try to validate the saved token
    if (this.adminToken) {
      await this.validateToken();
    }
  }

  // ─── AUTH ─────────────────────────────────────────────────────────────────

  authHeaders() {
    const headers = { 'Content-Type': 'application/json' };
    if (this.adminToken) {
      headers['Authorization'] = `Bearer ${this.adminToken}`;
    }
    return headers;
  }

  async validateToken() {
    try {
      const res = await fetch('/api/status', { headers: this.authHeaders() });
      const data = await res.json();
      if (data.config) {
        // Server returned full config, so our token is valid
        this.onAuthSuccess();
      } else {
        this.onAuthLogout(false);
      }
    } catch {
      this.onAuthLogout(false);
    }
  }

  onAuthSuccess() {
    this.isAdmin = true;
    document.getElementById('admin-nav').classList.remove('hidden');
    document.getElementById('sidebar-login-btn-wrap').classList.add('hidden');
    document.getElementById('sidebar-logout-wrap').classList.remove('hidden');
    this.loadConfig();
    this.loadBackups();
    this.loadMods();
    this.loadScenarios();
    this.connectLogStream();
    // Switch to dashboard if currently on the login screen
    if (document.getElementById('tab-adminlogin').classList.contains('active')) {
      this.switchTab('dashboard');
    }
  }

  onAuthLogout(clearStorage = true) {
    this.isAdmin = false;
    this.adminToken = null;
    if (clearStorage) localStorage.removeItem('se_admin_token');
    document.getElementById('admin-nav').classList.add('hidden');
    document.getElementById('sidebar-login-btn-wrap').classList.remove('hidden');
    document.getElementById('sidebar-logout-wrap').classList.add('hidden');
    if (this.logEventSource) {
      this.logEventSource.close();
      this.logEventSource = null;
    }
    this.switchTab('serverinfo');
  }

  setupAuthListeners() {
    // Setup form (first time)
    document.getElementById('setup-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const pw = document.getElementById('setup-password').value;
      const pw2 = document.getElementById('setup-password-confirm').value;
      const errEl = document.getElementById('setup-error');

      if (pw !== pw2) {
        errEl.textContent = 'Passwords do not match.';
        errEl.classList.remove('hidden');
        return;
      }
      if (pw.length < 6) {
        errEl.textContent = 'Password must be at least 6 characters.';
        errEl.classList.remove('hidden');
        return;
      }

      errEl.classList.add('hidden');
      const btn = document.getElementById('btn-setup-submit');
      btn.disabled = true;
      btn.textContent = 'Setting up...';

      try {
        const res = await fetch('/api/admin/setup', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ password: pw })
        });
        const data = await res.json();
        if (data.token) {
          this.adminToken = data.token;
          localStorage.setItem('se_admin_token', data.token);
          this.showNotification('Admin password set! Welcome to the dashboard.', 'success');
          this.onAuthSuccess();
        } else {
          throw new Error(data.error || 'Setup failed.');
        }
      } catch (err) {
        errEl.textContent = err.message;
        errEl.classList.remove('hidden');
        btn.disabled = false;
        btn.textContent = '🚀 Set Password & Enter Admin Panel';
      }
    });

    // Login form
    document.getElementById('login-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const pw = document.getElementById('login-password').value;
      const errEl = document.getElementById('login-error');
      errEl.classList.add('hidden');

      const btn = document.getElementById('btn-login-submit');
      btn.disabled = true;
      btn.textContent = 'Logging in...';

      try {
        const res = await fetch('/api/admin/login', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ password: pw })
        });
        const data = await res.json();
        if (data.token) {
          this.adminToken = data.token;
          localStorage.setItem('se_admin_token', data.token);
          this.showNotification('Logged in successfully!', 'success');
          this.onAuthSuccess();
        } else {
          throw new Error(data.error || 'Login failed.');
        }
      } catch (err) {
        errEl.textContent = err.message;
        errEl.classList.remove('hidden');
        btn.disabled = false;
        btn.textContent = '🔓 Log In';
        document.getElementById('login-password').value = '';
      }
    });

    // Logout button
    document.getElementById('btn-logout').addEventListener('click', async () => {
      try {
        await fetch('/api/admin/logout', {
          method: 'POST',
          headers: this.authHeaders()
        });
      } catch {}
      this.showNotification('Logged out successfully.', 'info');
      this.onAuthLogout(true);
    });
  }

  // Show the correct auth panel when navigating to admin login tab
  async showAuthPanel() {
    // Show loading first
    document.getElementById('auth-loading-panel').classList.remove('hidden');
    document.getElementById('auth-setup-panel').classList.add('hidden');
    document.getElementById('auth-login-panel').classList.add('hidden');

    try {
      const res = await fetch('/api/status');
      const data = await res.json();
      document.getElementById('auth-loading-panel').classList.add('hidden');
      if (!data.adminSetup) {
        document.getElementById('auth-setup-panel').classList.remove('hidden');
      } else {
        document.getElementById('auth-login-panel').classList.remove('hidden');
      }
    } catch {
      document.getElementById('auth-loading-panel').classList.add('hidden');
      document.getElementById('auth-login-panel').classList.remove('hidden');
    }
  }

  // ─── NOTIFICATIONS ─────────────────────────────────────────────────────────

  showNotification(text, type = 'info') {
    const notification = document.getElementById('notification');
    const notificationText = document.getElementById('notification-text');
    notificationText.textContent = text;
    notification.className = 'notification';
    if (type === 'error') notification.style.borderColor = 'var(--danger)';
    else if (type === 'success') notification.style.borderColor = 'var(--success)';
    else notification.style.borderColor = 'var(--primary)';
    notification.classList.remove('hidden');
    setTimeout(() => notification.classList.add('hidden'), 4000);
  }

  // ─── NAVIGATION ────────────────────────────────────────────────────────────

  switchTab(tabId) {
    // If switching to an admin tab without auth, redirect to login
    const adminTabs = ['dashboard', 'settings', 'mods', 'backups', 'console'];
    if (adminTabs.includes(tabId) && !this.isAdmin) {
      this.switchTab('adminlogin');
      return;
    }

    // If switching to login tab, show the correct auth panel
    if (tabId === 'adminlogin') {
      this.showAuthPanel();
    }

    document.querySelectorAll('.nav-btn').forEach(btn => {
      btn.classList.toggle('active', btn.getAttribute('data-tab') === tabId);
    });
    document.querySelectorAll('.tab-panel').forEach(panel => {
      panel.classList.toggle('active', panel.id === `tab-${tabId}`);
    });

    const titleMap = {
      serverinfo: { title: 'Server Info', subtitle: 'Live server status and public information' },
      activemods: { title: 'Active Mods', subtitle: 'Currently loaded Steam Workshop mods' },
      adminlogin: { title: 'Admin Access', subtitle: 'Password-protected control panel' },
      dashboard: { title: 'System Dashboard', subtitle: 'Real-time server monitoring and control' },
      settings: { title: 'Game Configurations', subtitle: 'Modify server property lists and parameters' },
      mods: { title: 'Steam Mods Manager', subtitle: 'Configure active Steam Workshop mods' },
      backups: { title: 'Saves & Backups', subtitle: 'Archive and restore worlds' },
      console: { title: 'Dedicated Server Console', subtitle: 'Direct wine stderr/stdout console log stream' }
    };

    const header = titleMap[tabId] || titleMap.serverinfo;
    document.getElementById('current-tab-title').textContent = header.title;
    document.getElementById('current-tab-subtitle').textContent = header.subtitle;

    if (tabId === 'settings' && this.isAdmin) this.loadConfig();
    else if (tabId === 'backups' && this.isAdmin) this.loadBackups();
    else if (tabId === 'mods' && this.isAdmin) this.loadMods();
  }

  setupEventListeners() {
    // All nav buttons
    document.querySelectorAll('.nav-btn').forEach(btn => {
      btn.addEventListener('click', () => this.switchTab(btn.getAttribute('data-tab')));
    });

    // Admin control buttons
    document.getElementById('btn-start').addEventListener('click', () => this.sendControlAction('start'));
    document.getElementById('btn-stop').addEventListener('click', () => this.sendControlAction('stop'));
    document.getElementById('btn-restart').addEventListener('click', () => this.sendControlAction('restart'));
    document.getElementById('btn-update').addEventListener('click', () => {
      if (confirm('Are you sure you want to stop the server and run SteamCMD update?')) {
        this.sendControlAction('update');
      }
    });

    // Config form
    document.getElementById('config-form').addEventListener('submit', (e) => {
      e.preventDefault();
      this.saveConfig();
    });

    // Mods Manager
    document.getElementById('btn-add-mod').addEventListener('click', () => this.addMod());
    document.getElementById('new-mod-id').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); this.addMod(); }
    });
    document.getElementById('btn-save-mods').addEventListener('click', () => this.saveMods());

    // Backups
    document.getElementById('btn-create-backup').addEventListener('click', () => this.createBackup());
    document.getElementById('btn-clear-console').addEventListener('click', () => {
      document.getElementById('full-console').innerHTML = '<div class="console-line system">[SYSTEM] Console cleared.</div>';
    });
    document.getElementById('btn-download-logs').addEventListener('click', () => {
      window.open(`/api/logs/full?token=${this.adminToken}`, '_blank');
    });

    // World Creator
    document.getElementById('create-world-form').addEventListener('submit', (e) => {
      e.preventDefault();
      this.createWorld();
    });
  }

  // ─── STATUS POLLING ────────────────────────────────────────────────────────

  startStatusPolling() {
    this.fetchStatus();
    this.statusInterval = setInterval(() => this.fetchStatus(), 3000);
  }

  async fetchStatus() {
    try {
      const response = await fetch('/api/status', { headers: this.authHeaders() });
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
    this.worlds = data.worlds || [];

    // ── Top stats bar ──
    const statusEl = document.getElementById('quick-status');
    statusEl.textContent = this.status;
    statusEl.className = 'stat-value ' + this.getStatusClass(this.status);

    document.getElementById('quick-cpu').textContent = `${data.cpu}%`;
    document.getElementById('quick-mem').textContent = `${data.memory} MB`;

    // ── Public Server Info panel ──
    document.getElementById('public-server-name').textContent = data.serverName || 'Space Engineers Server';
    document.getElementById('public-server-tagline').textContent =
      `${data.gameMode || 'Survival'} · Max ${data.maxPlayers || 4} players`;
    document.getElementById('pub-ip').textContent = data.serverIp || '0.0.0.0';
    document.getElementById('pub-playersonline').textContent = `${data.activePlayers || 0} / ${data.maxPlayers || 4}`;
    document.getElementById('pub-port').textContent = data.serverPort || '27016';
    document.getElementById('pub-gamemode').textContent = data.gameMode || 'Survival';
    document.getElementById('pub-maxplayers').textContent = data.maxPlayers || '4';
    document.getElementById('pub-world').textContent = data.activeWorld || 'Default World';
    document.getElementById('pub-modcount').textContent = (data.mods || []).length;

    // Public status badge
    const badge = document.getElementById('public-status-badge');
    badge.textContent = this.status;
    badge.className = 'status-badge ' + this.getStatusBadgeClass(this.status);

    // Beacon animation
    const beacon = document.getElementById('server-beacon');
    beacon.className = 'server-status-beacon ' + (this.status === 'RUNNING' ? 'beacon-running' : this.status === 'STARTING' ? 'beacon-starting' : 'beacon-stopped');

    // Public mods table
    this.renderPublicModsTable(data.mods || []);

    // ── Admin dashboard rings (only update when DOM is visible) ──
    const cpuVal = Math.min(100, Math.max(0, parseFloat(data.cpu) || 0));
    const memPercent = Math.min(100, ((parseInt(data.memory) || 0) / 8192) * 100);

    // Public rings
    document.getElementById('cpu-ring').setAttribute('stroke-dasharray', `${cpuVal}, 100`);
    document.getElementById('cpu-ring-text').textContent = `${Math.round(cpuVal)}%`;
    document.getElementById('mem-ring').setAttribute('stroke-dasharray', `${memPercent.toFixed(0)}, 100`);
    document.getElementById('mem-ring-text').textContent = `${memPercent.toFixed(0)}%`;

    // Admin rings
    document.getElementById('admin-cpu-ring').setAttribute('stroke-dasharray', `${cpuVal}, 100`);
    document.getElementById('admin-cpu-ring-text').textContent = `${Math.round(cpuVal)}%`;
    document.getElementById('admin-mem-ring').setAttribute('stroke-dasharray', `${memPercent.toFixed(0)}, 100`);
    document.getElementById('admin-mem-ring-text').textContent = `${memPercent.toFixed(0)}%`;

    // Console dot
    const consoleDot = document.getElementById('console-status-indicator');
    consoleDot.className = 'console-indicator ' + this.getConsoleDotClass(this.status);

    // Control buttons
    if (this.isAdmin) {
      document.getElementById('btn-start').disabled = (this.status !== 'STOPPED');
      document.getElementById('btn-stop').disabled = (this.status !== 'RUNNING' && this.status !== 'STARTING');
      document.getElementById('btn-restart').disabled = (this.status !== 'RUNNING');
      document.getElementById('btn-update').disabled = (this.status !== 'STOPPED');
    }

    // Active world in admin dashboard
    document.getElementById('active-world-name').textContent = this.activeWorld;

    // Uptime
    if (this.status === 'RUNNING' || this.status === 'STARTING') {
      this.uptime = data.uptime;
      this.startUptimeTicker();
    } else {
      this.stopUptimeTicker();
      document.getElementById('quick-uptime').textContent = '00:00:00';
    }
  }

  renderPublicModsTable(mods) {
    const tbody = document.getElementById('public-mods-table-body');
    if (!mods || mods.length === 0) {
      tbody.innerHTML = `<tr><td colspan="3" class="text-center">No mods are currently configured on this server.</td></tr>`;
      return;
    }
    tbody.innerHTML = mods.map(mod => `
      <tr>
        <td><strong>${mod.title || 'Unknown Mod'}</strong></td>
        <td><code>${mod.id}</code></td>
        <td>
          <a href="https://steamcommunity.com/sharedfiles/filedetails/?id=${mod.id}" target="_blank" class="table-link">
            Workshop 🔗
          </a>
        </td>
      </tr>
    `).join('');
  }

  getStatusClass(status) {
    const map = { RUNNING: 'status-running', STARTING: 'status-starting', STOPPED: 'status-stopped', STOPPING: 'status-stopped', UPDATING: 'status-updating' };
    return map[status] || 'status-stopped';
  }

  getStatusBadgeClass(status) {
    const map = { RUNNING: 'badge-running', STARTING: 'badge-starting', STOPPED: 'badge-stopped', STOPPING: 'badge-stopped', UPDATING: 'badge-updating' };
    return map[status] || 'badge-stopped';
  }

  getConsoleDotClass(status) {
    const map = { RUNNING: 'status-dot-running', STARTING: 'status-dot-starting', STOPPED: 'status-dot-stopped', STOPPING: 'status-dot-stopped', UPDATING: 'status-dot-updating' };
    return map[status] || 'status-dot-stopped';
  }

  startUptimeTicker() {
    if (this.uptimeInterval) return;
    this.uptimeInterval = setInterval(() => {
      this.uptime++;
      const t = this.formatTime(this.uptime);
      document.getElementById('quick-uptime').textContent = t;
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

  // ─── CONTROL ───────────────────────────────────────────────────────────────

  async sendControlAction(action) {
    try {
      const response = await fetch('/api/control', {
        method: 'POST',
        headers: this.authHeaders(),
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

  // ─── LOG STREAM ────────────────────────────────────────────────────────────

  connectLogStream() {
    if (this.logEventSource) this.logEventSource.close();
    const url = `/api/logs/stream?token=${encodeURIComponent(this.adminToken)}`;
    this.logEventSource = new EventSource(url);
    this.logEventSource.onmessage = (event) => {
      const log = JSON.parse(event.data);
      this.appendConsoleLine(log);
    };
    this.logEventSource.onerror = () => {
      console.warn('SSE log connection lost. Reconnecting in 5s...');
      this.logEventSource.close();
      if (this.isAdmin) {
        setTimeout(() => this.connectLogStream(), 5000);
      }
    };
  }

  appendConsoleLine(log) {
    const miniConsole = document.getElementById('mini-console');
    const fullConsole = document.getElementById('full-console');
    const time = log.timestamp ? log.timestamp.substring(11, 19) : new Date().toLocaleTimeString();
    const cleanText = log.text.replace(/[\u001b\u009b][[()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><]/g, '');
    const lineHtml = `<div class="console-line ${log.type}">[${time}] ${cleanText}</div>`;

    const isMiniScrolled = miniConsole.scrollHeight - miniConsole.clientHeight <= miniConsole.scrollTop + 50;
    miniConsole.insertAdjacentHTML('beforeend', lineHtml);
    if (isMiniScrolled) miniConsole.scrollTop = miniConsole.scrollHeight;

    const isFullScrolled = fullConsole.scrollHeight - fullConsole.clientHeight <= fullConsole.scrollTop + 50;
    fullConsole.insertAdjacentHTML('beforeend', lineHtml);
    if (isFullScrolled) fullConsole.scrollTop = fullConsole.scrollHeight;
  }

  // ─── CONFIG ────────────────────────────────────────────────────────────────

  async loadConfig() {
    try {
      const response = await fetch('/api/config', { headers: this.authHeaders() });
      if (!response.ok) throw new Error('Could not load game configuration');
      const data = await response.json();

      // ── Accordion 1: Server Core & Visibility ──
      document.getElementById('cfg-serverName').value = data.serverName || '';
      document.getElementById('cfg-port').value = data.port || 27016;
      document.getElementById('cfg-ip').value = data.ip || '0.0.0.0';
      document.getElementById('cfg-password').value = data.password || '';
      document.getElementById('cfg-groupId').value = data.groupId || '';
      document.getElementById('cfg-serverDescription').value = data.serverDescription || '';
      document.getElementById('cfg-onlineMode').value = data.onlineMode || 'PUBLIC';
      document.getElementById('cfg-pauseGameWhenEmpty').checked = !!data.pauseGameWhenEmpty;
      document.getElementById('cfg-ignoreLastSession').checked = !!data.ignoreLastSession;
      document.getElementById('cfg-gameMode').value = data.gameMode || 'Survival';
      document.getElementById('cfg-maxPlayers').value = data.maxPlayers ?? 4;
      document.getElementById('cfg-maxBackupSaves').value = data.maxBackupSaves ?? 5;

      // World selector
      const worldSelect = document.getElementById('cfg-worldName');
      worldSelect.innerHTML = '';
      const worldsList = this.worlds.length > 0 ? this.worlds : [data.worldName];
      if (!worldsList.includes(data.worldName)) worldsList.push(data.worldName);
      worldsList.forEach(world => {
        const opt = document.createElement('option');
        opt.value = world;
        opt.textContent = world;
        opt.selected = (world === data.worldName);
        worldSelect.appendChild(opt);
      });

      // ── Accordion 2: Speeds & Multipliers ──
      document.getElementById('cfg-inventorySizeMultiplier').value = data.inventorySizeMultiplier ?? 1;
      document.getElementById('cfg-blocksInventorySizeMultiplier').value = data.blocksInventorySizeMultiplier ?? 1;
      document.getElementById('cfg-assemblerSpeedMultiplier').value = data.assemblerSpeedMultiplier ?? 1;
      document.getElementById('cfg-assemblerEfficiencyMultiplier').value = data.assemblerEfficiencyMultiplier ?? 1;
      document.getElementById('cfg-refinerySpeedMultiplier').value = data.refinerySpeedMultiplier ?? 1;
      document.getElementById('cfg-welderSpeedMultiplier').value = data.welderSpeedMultiplier ?? 1;
      document.getElementById('cfg-grinderSpeedMultiplier').value = data.grinderSpeedMultiplier ?? 1;
      document.getElementById('cfg-hackSpeedMultiplier').value = data.hackSpeedMultiplier ?? 0.33;
      document.getElementById('cfg-spawnShipTimeMultiplier').value = data.spawnShipTimeMultiplier ?? 1;
      document.getElementById('cfg-characterSpeedMultiplier').value = data.characterSpeedMultiplier ?? 1;
      document.getElementById('cfg-environmentDamageMultiplier').value = data.environmentDamageMultiplier ?? 1;
      document.getElementById('cfg-backpackDespawnTimer').value = data.backpackDespawnTimer ?? 5;
      document.getElementById('cfg-maxProductionQueueLength').value = data.maxProductionQueueLength ?? 50;
      document.getElementById('cfg-autoSaveInMinutes').value = data.autoSaveInMinutes ?? 5;

      // ── Accordion 3: Toggles & Gameplay Rules ──
      document.getElementById('cfg-experimentalMode').checked = !!data.experimentalMode;
      document.getElementById('cfg-enableIngameScripts').checked = !!data.enableIngameScripts;
      document.getElementById('cfg-enableOxygen').checked = !!data.enableOxygen;
      document.getElementById('cfg-enableOxygenPressurization').checked = !!data.enableOxygenPressurization;
      document.getElementById('cfg-enableJetpack').checked = !!data.enableJetpack;
      document.getElementById('cfg-enableVoxelDestruction').checked = !!data.enableVoxelDestruction;
      document.getElementById('cfg-enable3rdPersonView').checked = !!data.enable3rdPersonView;
      document.getElementById('cfg-enableConvertToStation').checked = !!data.enableConvertToStation;
      document.getElementById('cfg-stationVoxelSupport').checked = !!data.stationVoxelSupport;
      document.getElementById('cfg-enableSpectator').checked = !!data.enableSpectator;
      document.getElementById('cfg-enableToolShake').checked = !!data.enableToolShake;
      document.getElementById('cfg-weaponsEnabled').checked = !!data.weaponsEnabled;
      document.getElementById('cfg-cargoShipsEnabled').checked = !!data.cargoShipsEnabled;
      document.getElementById('cfg-autoHealing').checked = !!data.autoHealing;
      document.getElementById('cfg-enableCopyPaste').checked = !!data.enableCopyPaste;
      document.getElementById('cfg-adaptiveSimulationQuality').checked = !!data.adaptiveSimulationQuality;
      document.getElementById('cfg-showPlayerNamesOnHud').checked = !!data.showPlayerNamesOnHud;
      document.getElementById('cfg-thrusterDamage').checked = !!data.thrusterDamage;
      document.getElementById('cfg-respawnShipDelete').checked = !!data.respawnShipDelete;
      document.getElementById('cfg-resetOwnership').checked = !!data.resetOwnership;
      document.getElementById('cfg-realisticSound').checked = !!data.realisticSound;
      document.getElementById('cfg-permanentDeath').checked = !!data.permanentDeath;
      document.getElementById('cfg-enableSaving').checked = !!data.enableSaving;
      document.getElementById('cfg-infiniteAmmo').checked = !!data.infiniteAmmo;
      document.getElementById('cfg-enableContainerDrops').checked = !!data.enableContainerDrops;
      document.getElementById('cfg-destructibleBlocks').checked = !!data.destructibleBlocks;
      document.getElementById('cfg-enableSunRotation').checked = !!data.enableSunRotation;
      document.getElementById('cfg-enableRespawnShips').checked = !!data.enableRespawnShips;
      document.getElementById('cfg-scenarioEditMode').checked = !!data.scenarioEditMode;
      document.getElementById('cfg-scenario').checked = !!data.scenario;
      document.getElementById('cfg-updateRespawnDictionary').checked = !!data.updateRespawnDictionary;
      document.getElementById('cfg-canJoinRunning').checked = !!data.canJoinRunning;
      document.getElementById('cfg-spawnWithTools').checked = !!data.spawnWithTools;
      document.getElementById('cfg-blueprintShare').checked = !!data.blueprintShare;
      document.getElementById('cfg-startInRespawnScreen').checked = !!data.startInRespawnScreen;
      document.getElementById('cfg-enableResearch').checked = !!data.enableResearch;
      document.getElementById('cfg-enableGoodBotHints').checked = !!data.enableGoodBotHints;
      document.getElementById('cfg-enableAutorespawn').checked = !!data.enableAutorespawn;
      document.getElementById('cfg-enableBountyContracts').checked = !!data.enableBountyContracts;
      document.getElementById('cfg-enableSupergridding').checked = !!data.enableSupergridding;
      document.getElementById('cfg-enableEconomy').checked = !!data.enableEconomy;
      document.getElementById('cfg-weatherSystem').checked = !!data.weatherSystem;
      document.getElementById('cfg-weatherLightingDamage').checked = !!data.weatherLightingDamage;
      document.getElementById('cfg-simplifiedSimulation').checked = !!data.simplifiedSimulation;
      document.getElementById('cfg-enablePcuTrading').checked = !!data.enablePcuTrading;
      document.getElementById('cfg-familySharing').checked = !!data.familySharing;
      document.getElementById('cfg-enableSelectivePhysicsUpdates').checked = !!data.enableSelectivePhysicsUpdates;
      document.getElementById('cfg-predefinedAsteroids').checked = !!data.predefinedAsteroids;
      document.getElementById('cfg-useConsolePCU').checked = !!data.useConsolePCU;
      document.getElementById('cfg-offensiveWordsFiltering').checked = !!data.offensiveWordsFiltering;
      document.getElementById('cfg-adjustableMaxVehicleSpeed').checked = !!data.adjustableMaxVehicleSpeed;
      document.getElementById('cfg-enableMatchComponent').checked = !!data.enableMatchComponent;
      document.getElementById('cfg-enableFriendlyFire').checked = !!data.enableFriendlyFire;
      document.getElementById('cfg-enableTeamBalancing').checked = !!data.enableTeamBalancing;
      document.getElementById('cfg-enableRecoil').checked = !!data.enableRecoil;
      document.getElementById('cfg-enableGamepadAimAssist').checked = !!data.enableGamepadAimAssist;
      document.getElementById('cfg-enableTeamScoreCounters').checked = !!data.enableTeamScoreCounters;
      document.getElementById('cfg-enableSpaceSuitRespawn').checked = !!data.enableSpaceSuitRespawn;
      document.getElementById('cfg-enableFactionVoiceChat').checked = !!data.enableFactionVoiceChat;
      document.getElementById('cfg-enableOrca').checked = !!data.enableOrca;
      document.getElementById('cfg-scrapEnabled').checked = !!data.scrapEnabled;
      document.getElementById('cfg-temporaryContainers').checked = !!data.temporaryContainers;
      document.getElementById('cfg-enableShareInertiaTensor').checked = !!data.enableShareInertiaTensor;
      document.getElementById('cfg-enableUnsafePistonImpulses').checked = !!data.enableUnsafePistonImpulses;
      document.getElementById('cfg-enableUnsafeRotorTorques').checked = !!data.enableUnsafeRotorTorques;
      document.getElementById('cfg-enableRadiation').checked = !!data.enableRadiation;
      document.getElementById('cfg-resetForageableItems').checked = !!data.resetForageableItems;
      document.getElementById('cfg-enableSurvivalBuffs').checked = !!data.enableSurvivalBuffs;
      document.getElementById('cfg-enableReducedStatsOnRespawn').checked = !!data.enableReducedStatsOnRespawn;
      document.getElementById('cfg-enableVoxelHand').checked = !!data.enableVoxelHand;

      // ── Accordion 4: Limits & Spawning ──
      document.getElementById('cfg-viewDistance').value = data.viewDistance ?? 15000;
      document.getElementById('cfg-syncDistance').value = data.syncDistance ?? 3000;
      document.getElementById('cfg-maxFloatingObjects').value = data.maxFloatingObjects ?? 56;
      document.getElementById('cfg-totalBotLimit').value = data.totalBotLimit ?? 32;
      document.getElementById('cfg-maxGridSize').value = data.maxGridSize ?? 0;
      document.getElementById('cfg-maxBlocksPerPlayer').value = data.maxBlocksPerPlayer ?? 0;
      document.getElementById('cfg-totalPCU').value = data.totalPCU ?? 100000;
      document.getElementById('cfg-piratePCU').value = data.piratePCU ?? 25000;
      document.getElementById('cfg-globalEncounterPCU').value = data.globalEncounterPCU ?? 25000;
      document.getElementById('cfg-maxFactionsCount').value = data.maxFactionsCount ?? 0;
      document.getElementById('cfg-worldSizeKm').value = data.worldSizeKm ?? 0;
      document.getElementById('cfg-maxPlanets').value = data.maxPlanets ?? 99;
      document.getElementById('cfg-optimalSpawnDistance').value = data.optimalSpawnDistance ?? 16000;
      document.getElementById('cfg-minimumWorldSize').value = data.minimumWorldSize ?? 6000;
      document.getElementById('cfg-maxCargoBags').value = data.maxCargoBags ?? 100;
      document.getElementById('cfg-maxHudChatMessageCount').value = data.maxHudChatMessageCount ?? 100;
      document.getElementById('cfg-solarRadiationIntensity').value = data.solarRadiationIntensity ?? 0;
      document.getElementById('cfg-physicsIterations').value = data.physicsIterations ?? 8;
      document.getElementById('cfg-proceduralDensity').value = data.proceduralDensity ?? 0.35;
      document.getElementById('cfg-proceduralSeed').value = data.proceduralSeed ?? 0;
      document.getElementById('cfg-blueprintShareTimeout').value = data.blueprintShareTimeout ?? 30;
      document.getElementById('cfg-environmentHostility').value = data.environmentHostility || 'SAFE';
      document.getElementById('cfg-blockLimitsEnabled').value = data.blockLimitsEnabled || 'NONE';
      document.getElementById('cfg-limitBlocksBy').value = data.limitBlocksBy || 'BlockPairName';
      document.getElementById('cfg-enableBlockLimits').checked = !!data.enableBlockLimits;

      // ── Accordion 5: Trash Removal & Cleanup ──
      document.getElementById('cfg-trashRemovalEnabled').checked = !!data.trashRemovalEnabled;
      document.getElementById('cfg-voxelTrashRemovalEnabled').checked = !!data.voxelTrashRemovalEnabled;
      document.getElementById('cfg-enableTrashSettingsPlatformOverride').checked = !!data.enableTrashSettingsPlatformOverride;
      document.getElementById('cfg-stopGridsPeriodMin').value = data.stopGridsPeriodMin ?? 15;
      document.getElementById('cfg-trashFlagsValue').value = data.trashFlagsValue ?? 1562;
      document.getElementById('cfg-afkTimeountMin').value = data.afkTimeountMin ?? 0;
      document.getElementById('cfg-blockCountThreshold').value = data.blockCountThreshold ?? 20;
      document.getElementById('cfg-playerDistanceThreshold').value = data.playerDistanceThreshold ?? 500;
      document.getElementById('cfg-optimalGridCount').value = data.optimalGridCount ?? 0;
      document.getElementById('cfg-playerInactivityThreshold').value = data.playerInactivityThreshold ?? 0;
      document.getElementById('cfg-playerCharacterRemovalThreshold').value = data.playerCharacterRemovalThreshold ?? 15;
      document.getElementById('cfg-removeOldIdentitiesH').value = data.removeOldIdentitiesH ?? 0;
      document.getElementById('cfg-voxelPlayerDistanceThreshold').value = data.voxelPlayerDistanceThreshold ?? 5000;
      document.getElementById('cfg-voxelGridDistanceThreshold').value = data.voxelGridDistanceThreshold ?? 5000;
      document.getElementById('cfg-voxelAgeThreshold').value = data.voxelAgeThreshold ?? 24;
      document.getElementById('cfg-trashCleanerCargoBagsMaxLiveTime').value = data.trashCleanerCargoBagsMaxLiveTime ?? 30;

      // ── Accordion 6: Encounters & AI ──
      document.getElementById('cfg-enableDrones').checked = !!data.enableDrones;
      document.getElementById('cfg-enableWolfs').checked = !!data.enableWolfs;
      document.getElementById('cfg-enableSpiders').checked = !!data.enableSpiders;
      document.getElementById('cfg-maxDrones').value = data.maxDrones ?? 5;
      document.getElementById('cfg-globalEncounterTimer').value = data.globalEncounterTimer ?? 15;
      document.getElementById('cfg-globalEncounterCap').value = data.globalEncounterCap ?? 1;
      document.getElementById('cfg-globalEncounterEnableRemovalTimer').checked = !!data.globalEncounterEnableRemovalTimer;
      document.getElementById('cfg-globalEncounterMinRemovalTimer').value = data.globalEncounterMinRemovalTimer ?? 90;
      document.getElementById('cfg-globalEncounterMaxRemovalTimer').value = data.globalEncounterMaxRemovalTimer ?? 180;
      document.getElementById('cfg-globalEncounterRemovalTimeClock').value = data.globalEncounterRemovalTimeClock ?? 30;
      document.getElementById('cfg-encounterDensity').value = data.encounterDensity ?? 0.35;
      document.getElementById('cfg-encounterGeneratorVersion').value = data.encounterGeneratorVersion ?? 6;
      document.getElementById('cfg-enablePlanetaryEncounters').checked = !!data.enablePlanetaryEncounters;
      document.getElementById('cfg-planetaryEncounterTimerMin').value = data.planetaryEncounterTimerMin ?? 15;
      document.getElementById('cfg-planetaryEncounterTimerMax').value = data.planetaryEncounterTimerMax ?? 30;
      document.getElementById('cfg-planetaryEncounterTimerFirst').value = data.planetaryEncounterTimerFirst ?? 5;
      document.getElementById('cfg-planetaryEncounterExistingStructuresRange').value = data.planetaryEncounterExistingStructuresRange ?? 7000;
      document.getElementById('cfg-planetaryEncounterAreaLockdownRange').value = data.planetaryEncounterAreaLockdownRange ?? 10000;
      document.getElementById('cfg-planetaryEncounterDesiredSpawnRange').value = data.planetaryEncounterDesiredSpawnRange ?? 6000;
      document.getElementById('cfg-planetaryEncounterPresenceRange').value = data.planetaryEncounterPresenceRange ?? 20000;
      document.getElementById('cfg-planetaryEncounterDespawnTimeout').value = data.planetaryEncounterDespawnTimeout ?? 120;

      // ── Accordion 7: Economy & Factions ──
      document.getElementById('cfg-enableFactionPlayerNames').checked = !!data.enableFactionPlayerNames;
      document.getElementById('cfg-enableFactionVoiceChat').checked = !!data.enableFactionVoiceChat;
      document.getElementById('cfg-tradeFactionsCount').value = data.tradeFactionsCount ?? 10;
      document.getElementById('cfg-stationsDistanceInnerRadius').value = data.stationsDistanceInnerRadius ?? 5000000;
      document.getElementById('cfg-stationsDistanceOuterRadiusStart').value = data.stationsDistanceOuterRadiusStart ?? 5000000;
      document.getElementById('cfg-stationsDistanceOuterRadiusEnd').value = data.stationsDistanceOuterRadiusEnd ?? 10000000;
      document.getElementById('cfg-economyTickInSeconds').value = data.economyTickInSeconds ?? 600;
      document.getElementById('cfg-npcGridClaimTimeLimit').value = data.npcGridClaimTimeLimit ?? 120;

      // ── Accordion 8: Grid Storage ──
      document.getElementById('cfg-gridStorageAllowsInventory').checked = !!data.gridStorageAllowsInventory;
      document.getElementById('cfg-gridStorageMaxPerPlayer').value = data.gridStorageMaxPerPlayer ?? 100;
      document.getElementById('cfg-gridStorageQueueLimit').value = data.gridStorageQueueLimit ?? 1;
      document.getElementById('cfg-gridStorageRetrievalTimeMaxMinutes').value = data.gridStorageRetrievalTimeMaxMinutes ?? 30;
      document.getElementById('cfg-gridStorageRetrievalTimeMinMinutes').value = data.gridStorageRetrievalTimeMinMinutes ?? 2;
      document.getElementById('cfg-gridStorageRetrievalTimeMultiplier').value = data.gridStorageRetrievalTimeMultiplier ?? 1;
      document.getElementById('cfg-gridStorageMinutesPerPCU').value = data.gridStorageMinutesPerPCU ?? 0.001;
      document.getElementById('cfg-gridStorageExpediteFactor').value = data.gridStorageExpediteFactor ?? 0.5;
      document.getElementById('cfg-gridStorageExpediteCostPerSecond').value = data.gridStorageExpediteCostPerSecond ?? 1000;

      // ── Accordion 9: Server Manager Auto-Backups ──
      const statusRes = await fetch('/api/status', { headers: this.authHeaders() });
      const statusData = await statusRes.json();
      const mgrCfg = statusData.config || {};
      document.getElementById('mgr-autoBackupEnabled').checked = !!mgrCfg.autoBackupEnabled;
      document.getElementById('mgr-autoBackupIntervalHours').value = mgrCfg.autoBackupIntervalHours ?? 6;
      document.getElementById('mgr-autoBackupRetentionCount').value = mgrCfg.autoBackupRetentionCount ?? 5;

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
      const sedsUpdates = {
        // ── Accordion 1: Server Core & Visibility ──
        serverName: document.getElementById('cfg-serverName').value,
        port: parseInt(document.getElementById('cfg-port').value),
        ip: document.getElementById('cfg-ip').value,
        worldName: document.getElementById('cfg-worldName').value,
        password: document.getElementById('cfg-password').value,
        groupId: document.getElementById('cfg-groupId').value,
        serverDescription: document.getElementById('cfg-serverDescription').value,
        onlineMode: document.getElementById('cfg-onlineMode').value,
        pauseGameWhenEmpty: document.getElementById('cfg-pauseGameWhenEmpty').checked,
        ignoreLastSession: document.getElementById('cfg-ignoreLastSession').checked,
        gameMode: document.getElementById('cfg-gameMode').value,
        maxPlayers: parseInt(document.getElementById('cfg-maxPlayers').value),
        maxBackupSaves: parseInt(document.getElementById('cfg-maxBackupSaves').value),

        // ── Accordion 2: Speeds & Multipliers ──
        inventorySizeMultiplier: parseFloat(document.getElementById('cfg-inventorySizeMultiplier').value),
        blocksInventorySizeMultiplier: parseFloat(document.getElementById('cfg-blocksInventorySizeMultiplier').value),
        assemblerSpeedMultiplier: parseFloat(document.getElementById('cfg-assemblerSpeedMultiplier').value),
        assemblerEfficiencyMultiplier: parseFloat(document.getElementById('cfg-assemblerEfficiencyMultiplier').value),
        refinerySpeedMultiplier: parseFloat(document.getElementById('cfg-refinerySpeedMultiplier').value),
        welderSpeedMultiplier: parseFloat(document.getElementById('cfg-welderSpeedMultiplier').value),
        grinderSpeedMultiplier: parseFloat(document.getElementById('cfg-grinderSpeedMultiplier').value),
        hackSpeedMultiplier: parseFloat(document.getElementById('cfg-hackSpeedMultiplier').value),
        spawnShipTimeMultiplier: parseFloat(document.getElementById('cfg-spawnShipTimeMultiplier').value),
        characterSpeedMultiplier: parseFloat(document.getElementById('cfg-characterSpeedMultiplier').value),
        environmentDamageMultiplier: parseFloat(document.getElementById('cfg-environmentDamageMultiplier').value),
        backpackDespawnTimer: parseInt(document.getElementById('cfg-backpackDespawnTimer').value),
        maxProductionQueueLength: parseInt(document.getElementById('cfg-maxProductionQueueLength').value),
        autoSaveInMinutes: parseInt(document.getElementById('cfg-autoSaveInMinutes').value),

        // ── Accordion 3: Toggles & Gameplay Rules ──
        experimentalMode: document.getElementById('cfg-experimentalMode').checked,
        enableIngameScripts: document.getElementById('cfg-enableIngameScripts').checked,
        enableOxygen: document.getElementById('cfg-enableOxygen').checked,
        enableOxygenPressurization: document.getElementById('cfg-enableOxygenPressurization').checked,
        enableJetpack: document.getElementById('cfg-enableJetpack').checked,
        enableVoxelDestruction: document.getElementById('cfg-enableVoxelDestruction').checked,
        enable3rdPersonView: document.getElementById('cfg-enable3rdPersonView').checked,
        enableConvertToStation: document.getElementById('cfg-enableConvertToStation').checked,
        stationVoxelSupport: document.getElementById('cfg-stationVoxelSupport').checked,
        enableSpectator: document.getElementById('cfg-enableSpectator').checked,
        enableToolShake: document.getElementById('cfg-enableToolShake').checked,
        weaponsEnabled: document.getElementById('cfg-weaponsEnabled').checked,
        cargoShipsEnabled: document.getElementById('cfg-cargoShipsEnabled').checked,
        autoHealing: document.getElementById('cfg-autoHealing').checked,
        enableCopyPaste: document.getElementById('cfg-enableCopyPaste').checked,
        adaptiveSimulationQuality: document.getElementById('cfg-adaptiveSimulationQuality').checked,
        showPlayerNamesOnHud: document.getElementById('cfg-showPlayerNamesOnHud').checked,
        thrusterDamage: document.getElementById('cfg-thrusterDamage').checked,
        respawnShipDelete: document.getElementById('cfg-respawnShipDelete').checked,
        resetOwnership: document.getElementById('cfg-resetOwnership').checked,
        realisticSound: document.getElementById('cfg-realisticSound').checked,
        permanentDeath: document.getElementById('cfg-permanentDeath').checked,
        enableSaving: document.getElementById('cfg-enableSaving').checked,
        infiniteAmmo: document.getElementById('cfg-infiniteAmmo').checked,
        enableContainerDrops: document.getElementById('cfg-enableContainerDrops').checked,
        destructibleBlocks: document.getElementById('cfg-destructibleBlocks').checked,
        enableSunRotation: document.getElementById('cfg-enableSunRotation').checked,
        enableRespawnShips: document.getElementById('cfg-enableRespawnShips').checked,
        scenarioEditMode: document.getElementById('cfg-scenarioEditMode').checked,
        scenario: document.getElementById('cfg-scenario').checked,
        updateRespawnDictionary: document.getElementById('cfg-updateRespawnDictionary').checked,
        canJoinRunning: document.getElementById('cfg-canJoinRunning').checked,
        spawnWithTools: document.getElementById('cfg-spawnWithTools').checked,
        blueprintShare: document.getElementById('cfg-blueprintShare').checked,
        startInRespawnScreen: document.getElementById('cfg-startInRespawnScreen').checked,
        enableResearch: document.getElementById('cfg-enableResearch').checked,
        enableGoodBotHints: document.getElementById('cfg-enableGoodBotHints').checked,
        enableAutorespawn: document.getElementById('cfg-enableAutorespawn').checked,
        enableBountyContracts: document.getElementById('cfg-enableBountyContracts').checked,
        enableSupergridding: document.getElementById('cfg-enableSupergridding').checked,
        enableEconomy: document.getElementById('cfg-enableEconomy').checked,
        weatherSystem: document.getElementById('cfg-weatherSystem').checked,
        weatherLightingDamage: document.getElementById('cfg-weatherLightingDamage').checked,
        simplifiedSimulation: document.getElementById('cfg-simplifiedSimulation').checked,
        enablePcuTrading: document.getElementById('cfg-enablePcuTrading').checked,
        familySharing: document.getElementById('cfg-familySharing').checked,
        enableSelectivePhysicsUpdates: document.getElementById('cfg-enableSelectivePhysicsUpdates').checked,
        predefinedAsteroids: document.getElementById('cfg-predefinedAsteroids').checked,
        useConsolePCU: document.getElementById('cfg-useConsolePCU').checked,
        offensiveWordsFiltering: document.getElementById('cfg-offensiveWordsFiltering').checked,
        adjustableMaxVehicleSpeed: document.getElementById('cfg-adjustableMaxVehicleSpeed').checked,
        enableMatchComponent: document.getElementById('cfg-enableMatchComponent').checked,
        enableFriendlyFire: document.getElementById('cfg-enableFriendlyFire').checked,
        enableTeamBalancing: document.getElementById('cfg-enableTeamBalancing').checked,
        enableRecoil: document.getElementById('cfg-enableRecoil').checked,
        enableGamepadAimAssist: document.getElementById('cfg-enableGamepadAimAssist').checked,
        enableTeamScoreCounters: document.getElementById('cfg-enableTeamScoreCounters').checked,
        enableSpaceSuitRespawn: document.getElementById('cfg-enableSpaceSuitRespawn').checked,
        enableFactionVoiceChat: document.getElementById('cfg-enableFactionVoiceChat').checked,
        enableOrca: document.getElementById('cfg-enableOrca').checked,
        scrapEnabled: document.getElementById('cfg-scrapEnabled').checked,
        temporaryContainers: document.getElementById('cfg-temporaryContainers').checked,
        enableShareInertiaTensor: document.getElementById('cfg-enableShareInertiaTensor').checked,
        enableUnsafePistonImpulses: document.getElementById('cfg-enableUnsafePistonImpulses').checked,
        enableUnsafeRotorTorques: document.getElementById('cfg-enableUnsafeRotorTorques').checked,
        enableRadiation: document.getElementById('cfg-enableRadiation').checked,
        resetForageableItems: document.getElementById('cfg-resetForageableItems').checked,
        enableSurvivalBuffs: document.getElementById('cfg-enableSurvivalBuffs').checked,
        enableReducedStatsOnRespawn: document.getElementById('cfg-enableReducedStatsOnRespawn').checked,
        enableVoxelHand: document.getElementById('cfg-enableVoxelHand').checked,

        // ── Accordion 4: Limits & Spawning ──
        viewDistance: parseInt(document.getElementById('cfg-viewDistance').value),
        syncDistance: parseInt(document.getElementById('cfg-syncDistance').value),
        maxFloatingObjects: parseInt(document.getElementById('cfg-maxFloatingObjects').value),
        totalBotLimit: parseInt(document.getElementById('cfg-totalBotLimit').value),
        maxGridSize: parseInt(document.getElementById('cfg-maxGridSize').value),
        maxBlocksPerPlayer: parseInt(document.getElementById('cfg-maxBlocksPerPlayer').value),
        totalPCU: parseInt(document.getElementById('cfg-totalPCU').value),
        piratePCU: parseInt(document.getElementById('cfg-piratePCU').value),
        globalEncounterPCU: parseInt(document.getElementById('cfg-globalEncounterPCU').value),
        maxFactionsCount: parseInt(document.getElementById('cfg-maxFactionsCount').value),
        worldSizeKm: parseInt(document.getElementById('cfg-worldSizeKm').value),
        maxPlanets: parseInt(document.getElementById('cfg-maxPlanets').value),
        optimalSpawnDistance: parseInt(document.getElementById('cfg-optimalSpawnDistance').value),
        minimumWorldSize: parseInt(document.getElementById('cfg-minimumWorldSize').value),
        maxCargoBags: parseInt(document.getElementById('cfg-maxCargoBags').value),
        maxHudChatMessageCount: parseInt(document.getElementById('cfg-maxHudChatMessageCount').value),
        solarRadiationIntensity: parseInt(document.getElementById('cfg-solarRadiationIntensity').value),
        physicsIterations: parseInt(document.getElementById('cfg-physicsIterations').value),
        proceduralDensity: parseFloat(document.getElementById('cfg-proceduralDensity').value),
        proceduralSeed: parseInt(document.getElementById('cfg-proceduralSeed').value),
        blueprintShareTimeout: parseInt(document.getElementById('cfg-blueprintShareTimeout').value),
        environmentHostility: document.getElementById('cfg-environmentHostility').value,
        blockLimitsEnabled: document.getElementById('cfg-blockLimitsEnabled').value,
        limitBlocksBy: document.getElementById('cfg-limitBlocksBy').value,
        enableBlockLimits: document.getElementById('cfg-enableBlockLimits').checked,

        // ── Accordion 5: Trash Removal & Cleanup ──
        trashRemovalEnabled: document.getElementById('cfg-trashRemovalEnabled').checked,
        voxelTrashRemovalEnabled: document.getElementById('cfg-voxelTrashRemovalEnabled').checked,
        enableTrashSettingsPlatformOverride: document.getElementById('cfg-enableTrashSettingsPlatformOverride').checked,
        stopGridsPeriodMin: parseInt(document.getElementById('cfg-stopGridsPeriodMin').value),
        trashFlagsValue: parseInt(document.getElementById('cfg-trashFlagsValue').value),
        afkTimeountMin: parseInt(document.getElementById('cfg-afkTimeountMin').value),
        blockCountThreshold: parseInt(document.getElementById('cfg-blockCountThreshold').value),
        playerDistanceThreshold: parseInt(document.getElementById('cfg-playerDistanceThreshold').value),
        optimalGridCount: parseInt(document.getElementById('cfg-optimalGridCount').value),
        playerInactivityThreshold: parseInt(document.getElementById('cfg-playerInactivityThreshold').value),
        playerCharacterRemovalThreshold: parseInt(document.getElementById('cfg-playerCharacterRemovalThreshold').value),
        removeOldIdentitiesH: parseInt(document.getElementById('cfg-removeOldIdentitiesH').value),
        voxelPlayerDistanceThreshold: parseInt(document.getElementById('cfg-voxelPlayerDistanceThreshold').value),
        voxelGridDistanceThreshold: parseInt(document.getElementById('cfg-voxelGridDistanceThreshold').value),
        voxelAgeThreshold: parseInt(document.getElementById('cfg-voxelAgeThreshold').value),
        trashCleanerCargoBagsMaxLiveTime: parseInt(document.getElementById('cfg-trashCleanerCargoBagsMaxLiveTime').value),

        // ── Accordion 6: Encounters & AI ──
        enableDrones: document.getElementById('cfg-enableDrones').checked,
        enableWolfs: document.getElementById('cfg-enableWolfs').checked,
        enableSpiders: document.getElementById('cfg-enableSpiders').checked,
        maxDrones: parseInt(document.getElementById('cfg-maxDrones').value),
        globalEncounterTimer: parseInt(document.getElementById('cfg-globalEncounterTimer').value),
        globalEncounterCap: parseInt(document.getElementById('cfg-globalEncounterCap').value),
        globalEncounterEnableRemovalTimer: document.getElementById('cfg-globalEncounterEnableRemovalTimer').checked,
        globalEncounterMinRemovalTimer: parseInt(document.getElementById('cfg-globalEncounterMinRemovalTimer').value),
        globalEncounterMaxRemovalTimer: parseInt(document.getElementById('cfg-globalEncounterMaxRemovalTimer').value),
        globalEncounterRemovalTimeClock: parseInt(document.getElementById('cfg-globalEncounterRemovalTimeClock').value),
        encounterDensity: parseFloat(document.getElementById('cfg-encounterDensity').value),
        encounterGeneratorVersion: parseInt(document.getElementById('cfg-encounterGeneratorVersion').value),
        enablePlanetaryEncounters: document.getElementById('cfg-enablePlanetaryEncounters').checked,
        planetaryEncounterTimerMin: parseInt(document.getElementById('cfg-planetaryEncounterTimerMin').value),
        planetaryEncounterTimerMax: parseInt(document.getElementById('cfg-planetaryEncounterTimerMax').value),
        planetaryEncounterTimerFirst: parseInt(document.getElementById('cfg-planetaryEncounterTimerFirst').value),
        planetaryEncounterExistingStructuresRange: parseInt(document.getElementById('cfg-planetaryEncounterExistingStructuresRange').value),
        planetaryEncounterAreaLockdownRange: parseInt(document.getElementById('cfg-planetaryEncounterAreaLockdownRange').value),
        planetaryEncounterDesiredSpawnRange: parseInt(document.getElementById('cfg-planetaryEncounterDesiredSpawnRange').value),
        planetaryEncounterPresenceRange: parseInt(document.getElementById('cfg-planetaryEncounterPresenceRange').value),
        planetaryEncounterDespawnTimeout: parseInt(document.getElementById('cfg-planetaryEncounterDespawnTimeout').value),

        // ── Accordion 7: Economy & Factions ──
        enableFactionPlayerNames: document.getElementById('cfg-enableFactionPlayerNames').checked,
        tradeFactionsCount: parseInt(document.getElementById('cfg-tradeFactionsCount').value),
        stationsDistanceInnerRadius: parseInt(document.getElementById('cfg-stationsDistanceInnerRadius').value),
        stationsDistanceOuterRadiusStart: parseInt(document.getElementById('cfg-stationsDistanceOuterRadiusStart').value),
        stationsDistanceOuterRadiusEnd: parseInt(document.getElementById('cfg-stationsDistanceOuterRadiusEnd').value),
        economyTickInSeconds: parseInt(document.getElementById('cfg-economyTickInSeconds').value),
        npcGridClaimTimeLimit: parseInt(document.getElementById('cfg-npcGridClaimTimeLimit').value),

        // ── Accordion 8: Grid Storage ──
        gridStorageAllowsInventory: document.getElementById('cfg-gridStorageAllowsInventory').checked,
        gridStorageMaxPerPlayer: parseInt(document.getElementById('cfg-gridStorageMaxPerPlayer').value),
        gridStorageQueueLimit: parseInt(document.getElementById('cfg-gridStorageQueueLimit').value),
        gridStorageRetrievalTimeMaxMinutes: parseInt(document.getElementById('cfg-gridStorageRetrievalTimeMaxMinutes').value),
        gridStorageRetrievalTimeMinMinutes: parseInt(document.getElementById('cfg-gridStorageRetrievalTimeMinMinutes').value),
        gridStorageRetrievalTimeMultiplier: parseFloat(document.getElementById('cfg-gridStorageRetrievalTimeMultiplier').value),
        gridStorageMinutesPerPCU: parseFloat(document.getElementById('cfg-gridStorageMinutesPerPCU').value),
        gridStorageExpediteFactor: parseFloat(document.getElementById('cfg-gridStorageExpediteFactor').value),
        gridStorageExpediteCostPerSecond: parseFloat(document.getElementById('cfg-gridStorageExpediteCostPerSecond').value)
      };

      const sedsRes = await fetch('/api/config', {
        method: 'POST',
        headers: this.authHeaders(),
        body: JSON.stringify(sedsUpdates)
      });
      if (!sedsRes.ok) throw new Error('SE Dedicated config save failed');

      const mgrUpdates = {
        autoBackupEnabled: document.getElementById('mgr-autoBackupEnabled').checked,
        autoBackupIntervalHours: parseFloat(document.getElementById('mgr-autoBackupIntervalHours').value),
        autoBackupRetentionCount: parseInt(document.getElementById('mgr-autoBackupRetentionCount').value)
      };

      const mgrRes = await fetch('/api/manager-config', {
        method: 'POST',
        headers: this.authHeaders(),
        body: JSON.stringify(mgrUpdates)
      });
      if (!mgrRes.ok) throw new Error('Server Manager config save failed');

      statusMsg.textContent = 'Configurations saved successfully!';
      statusMsg.className = 'status-msg success';
      this.showNotification('Configurations saved and synced successfully!', 'success');
      this.fetchStatus();
    } catch (err) {
      statusMsg.textContent = `Save failed: ${err.message}`;
      statusMsg.className = 'status-msg error';
      this.showNotification(`Config save failed: ${err.message}`, 'error');
    }
  }

  // ─── MODS ──────────────────────────────────────────────────────────────────

  async loadMods() {
    try {
      const response = await fetch('/api/mods', { headers: this.authHeaders() });
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
      const depBadge = mod.isDependency ? `<span class="badge-dep" title="Automatically added as a required dependency">DEP</span>` : '';
      const tr = document.createElement('tr');
      tr.className = mod.isDependency ? 'mod-row-dep' : '';
      tr.innerHTML = `
        <td><strong>${mod.title || 'Unknown Mod'}</strong> ${depBadge}</td>
        <td><code>${mod.id}</code></td>
        <td><a href="https://steamcommunity.com/sharedfiles/filedetails/?id=${mod.id}" target="_blank" class="table-link">Workshop 🔗</a></td>
        <td class="actions-col"><button class="btn btn-sm btn-danger btn-remove-mod" data-index="${index}">Remove</button></td>
      `;
      tbody.appendChild(tr);
    });
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
        headers: this.authHeaders(),
        body: JSON.stringify({ modId })
      });
      if (!response.ok) throw new Error('Steam details query failed');
      const data = await response.json();
      const resolvedMods = data.mods || [];
      if (resolvedMods.length === 0) throw new Error('Workshop ID not found or item does not exist');
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
        statusEl.textContent = `✅ Added '${mainModName}' + ${addedCount - 1} dependencies: ${addedNames.slice(1).join(', ')}`;
        statusEl.className = 'status-msg success';
        this.showNotification(`Added mod '${mainModName}' and ${addedCount - 1} missing dependencies!`, 'success');
      } else if (addedCount === 1) {
        statusEl.textContent = `✅ Added '${mainModName}' (no dependencies found)`;
        statusEl.className = 'status-msg success';
        this.showNotification(`Added mod '${mainModName}'!`, 'success');
      } else {
        statusEl.textContent = `ℹ️ Mod '${mainModName}' and all its dependencies are already in the list.`;
        statusEl.className = 'status-msg';
      }
      input.value = '';
      this.renderModsTable();
    } catch (err) {
      const confirmAdd = confirm(`Failed to resolve mod details from Steam Workshop: ${err.message}\n\nWould you like to add the Mod ID ${modId} anyway?`);
      if (confirmAdd) {
        this.mods.push({ id: modId, title: `Workshop Mod #${modId}` });
        this.renderModsTable();
        statusEl.textContent = `⚠️ Added Mod ID ${modId} without Steam details. Remember to save!`;
        statusEl.className = 'status-msg warning';
        input.value = '';
      } else {
        statusEl.textContent = `❌ Error: ${err.message}`;
        statusEl.className = 'status-msg error';
      }
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
        headers: this.authHeaders(),
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

  // ─── BACKUPS ───────────────────────────────────────────────────────────────

  async loadBackups() {
    try {
      const backupRes = await fetch('/api/backups', { headers: this.authHeaders() });
      if (!backupRes.ok) throw new Error('Could not fetch backups list');
      const backupData = await backupRes.json();
      this.backups = backupData.backups || [];
      this.renderBackupsTable();

      const statusRes = await fetch('/api/status', { headers: this.authHeaders() });
      const statusData = await statusRes.json();
      this.renderWorldsTable(statusData.worlds || [], statusData.activeWorld);
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
        <td><span class="${isActive ? 'status-running' : 'status-stopped'}">${isActive ? '● Active' : '○ Dormant'}</span></td>
        <td class="actions-col">
          ${isActive
            ? '<span class="status-msg success">Currently Loaded</span>'
            : `<button class="btn btn-sm btn-outline btn-activate-world" data-world="${world}">Activate</button>`}
        </td>
      `;
      tbody.appendChild(tr);
    });
    document.querySelectorAll('.btn-activate-world').forEach(btn => {
      btn.addEventListener('click', (e) => this.activateWorld(e.target.getAttribute('data-world')));
    });
  }

  async loadScenarios() {
    try {
      const response = await fetch('/api/scenarios', { headers: this.authHeaders() });
      if (!response.ok) throw new Error('Failed to load starting scenarios');
      const data = await response.json();
      const select = document.getElementById('new-world-scenario');
      select.innerHTML = '';
      const scenarios = data.scenarios && data.scenarios.length > 0 ? data.scenarios : ['Star System'];
      scenarios.forEach(sc => {
        const opt = document.createElement('option');
        opt.value = sc;
        opt.textContent = sc;
        select.appendChild(opt);
      });
    } catch (err) {
      console.error('Error loading scenarios:', err);
    }
  }

  async activateWorld(worldName) {
    if (this.status !== 'STOPPED') {
      this.showNotification('You must STOP the server before changing worlds!', 'error');
      return;
    }
    try {
      this.showNotification(`Activating world: ${worldName}...`, 'info');
      const response = await fetch('/api/worlds/activate', {
        method: 'POST',
        headers: this.authHeaders(),
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
        headers: this.authHeaders(),
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
    document.querySelectorAll('.btn-restore-backup').forEach(btn => {
      btn.addEventListener('click', (e) => this.restoreBackup(e.target.getAttribute('data-file')));
    });
    document.querySelectorAll('.btn-delete-backup').forEach(btn => {
      btn.addEventListener('click', (e) => this.deleteBackup(e.target.getAttribute('data-file')));
    });
  }

  async createBackup() {
    this.showNotification('Triggering server saves backup...', 'info');
    try {
      const response = await fetch('/api/backups/create', { method: 'POST', headers: this.authHeaders() });
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
      return;
    }
    if (confirm(`CRITICAL ACTION WARNING:\nAre you sure you want to restore the backup: ${filename}?\nThis will completely replace all current world saves.`)) {
      this.showNotification(`Restoring saves archive: ${filename}...`, 'info');
      try {
        const response = await fetch('/api/backups/restore', {
          method: 'POST',
          headers: this.authHeaders(),
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
        const response = await fetch(`/api/backups/${filename}`, { method: 'DELETE', headers: this.authHeaders() });
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
