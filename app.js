/* 베이비캠 — WebRTC(PeerJS) 기반 아기 모니터 */
(() => {
  'use strict';

  /* =========================================================
   *  설정
   * ========================================================= */
  function hashStr(s) {
    let h = 2166136261 >>> 0;
    for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0; }
    return h.toString(36);
  }
  const USER_CFG = window.BABYCAM_CONFIG || {};
  const CFG = {
    // 배포 주소별로 다른 접두어를 써서 다른 배포본과 코드가 섞이지 않게 함
    peerPrefix: USER_CFG.peerPrefix ||
      ('bcam-' + hashStr(location.host + location.pathname.replace(/index\.html$/, '')) + '-'),
    peerServer: USER_CFG.peerServer || null,
    meteredApp: (USER_CFG.meteredApp || '').trim(),
    meteredApiKey: (USER_CFG.meteredApiKey || '').trim(),
    turnServers: Array.isArray(USER_CFG.turnServers) ? USER_CFG.turnServers : [],
    stunServers: USER_CFG.stunServers || ['stun:stun.l.google.com:19302', 'stun:stun.cloudflare.com:3478']
  };
  const ALPHABET = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ'; // 헷갈리는 0·O·1·I 제외
  const CODE_LEN = 8;
  const MAX_VIEWERS = 4;
  const QUALITY = {
    low:  { label: '절약',   h: 360, bitrate: 250000,  fps: 10, hint: '360p · 시간당 약 0.13GB. LTE로 오래 볼 때 권장' },
    mid:  { label: '표준',   h: 480, bitrate: 650000,  fps: 15, hint: '480p · 시간당 약 0.3GB' },
    high: { label: '고화질', h: 720, bitrate: 1500000, fps: 20, hint: '720p · 시간당 약 0.7GB. 와이파이 권장' }
  };
  const ROUTE_LABEL = { direct: '직접 연결', relay: 'TURN 중계' };

  /* =========================================================
   *  공통 유틸
   * ========================================================= */
  const $ = id => document.getElementById(id);
  const show = (el, on = true) => el.classList.toggle('hidden', !on);
  function el(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }
  const store = {
    get(k, d) { try { const v = localStorage.getItem('babycam.' + k); return v == null ? d : JSON.parse(v); } catch (e) { return d; } },
    set(k, v) { try { localStorage.setItem('babycam.' + k, JSON.stringify(v)); } catch (e) {} }
  };
  let toastTimer = null;
  function toast(msg, ms = 2600) {
    const t = $('toast');
    t.textContent = msg; t.classList.add('show');
    clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.remove('show'), ms);
  }
  function genCode() {
    const a = new Uint32Array(CODE_LEN);
    crypto.getRandomValues(a);
    return Array.from(a, v => ALPHABET[v % ALPHABET.length]).join('');
  }
  const cleanCode = v => (v || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, CODE_LEN);
  const fmtCode = c => c.length > 4 ? c.slice(0, 4) + '-' + c.slice(4) : c;
  const pad = n => String(n).padStart(2, '0');
  const hhmm = (d = new Date()) => pad(d.getHours()) + ':' + pad(d.getMinutes());
  function fmtBytes(b) {
    const mb = b / 1048576;
    return mb >= 1024 ? (mb / 1024).toFixed(2) + 'GB' : (mb >= 100 ? mb.toFixed(0) : mb.toFixed(1)) + 'MB';
  }
  function send(conn, msg) { try { if (conn && conn.open) conn.send(msg); } catch (e) {} }
  function vibrate(p) { try { if (navigator.vibrate) navigator.vibrate(p); } catch (e) {} }

  /* ---------- 기기 정보 ---------- */
  let DEVICE_ID = store.get('deviceId', '');
  if (!/^[a-z0-9]{16}$/.test(DEVICE_ID)) {
    const a = new Uint8Array(8); crypto.getRandomValues(a);
    DEVICE_ID = Array.from(a, b => b.toString(16).padStart(2, '0')).join('');
    store.set('deviceId', DEVICE_ID);
  }
  function guessName() {
    const ua = navigator.userAgent;
    if (/iPhone/.test(ua)) return 'iPhone';
    if (/iPad/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1)) return 'iPad';
    const m = ua.match(/Android[^;)]*;\s*([^;)]+?)(?:\s+Build\/|\))/);
    if (m && m[1] && m[1].trim().length > 1 && !/^wv$/i.test(m[1].trim())) {
      let n = m[1].trim();
      if (/^SM-/i.test(n)) n = '갤럭시 ' + n;
      return n.slice(0, 20);
    }
    if (/Android/.test(ua)) return 'Android 폰';
    if (/Windows/.test(ua)) return 'Windows PC';
    if (/Mac/.test(ua)) return 'Mac';
    if (/Linux/.test(ua)) return 'PC';
    return '내 기기';
  }

  /* ---------- 사용자 설정 ---------- */
  const settings = Object.assign(
    { name: '', meteredApp: '', meteredKey: '', turnUrl: '', turnUser: '', turnPass: '', forceRelay: false },
    store.get('settings', {})
  );
  const myName = () => (settings.name || '').trim() || guessName();

  /* ---------- ICE(STUN/TURN) ---------- */
  let ICE_CACHE = { k: '', t: 0, v: [] };
  function turnConfigured(s = settings) {
    return !!((s.meteredApp && s.meteredKey) || (s.turnUrl || '').trim() ||
      (CFG.meteredApp && CFG.meteredApiKey) || CFG.turnServers.length);
  }
  async function getIceConfig(s = settings, noCache = false) {
    const iceServers = CFG.stunServers.map(u => ({ urls: u }));
    const turn = [];
    let error = '';
    let app = (s.meteredApp || '').trim(), key = (s.meteredKey || '').trim();
    if (!(app && key)) { app = CFG.meteredApp; key = CFG.meteredApiKey; }
    if (app && key) {
      const ck = app + '|' + key;
      if (!noCache && ICE_CACHE.k === ck && Date.now() - ICE_CACHE.t < 30 * 60000) {
        turn.push(...ICE_CACHE.v);
      } else if (!/^[a-z0-9.-]+$/i.test(app)) {
        error = '앱 이름 형식이 올바르지 않습니다';
      } else {
        const host = app.includes('.') ? app : app + '.metered.live';
        const ctl = typeof AbortController !== 'undefined' ? new AbortController() : null;
        const to = setTimeout(() => ctl && ctl.abort(), 7000);
        try {
          const r = await fetch('https://' + host + '/api/v1/turn/credentials?apiKey=' + encodeURIComponent(key),
            ctl ? { signal: ctl.signal } : {});
          if (!r.ok) error = 'Metered 응답 오류 (HTTP ' + r.status + ')';
          else {
            const j = await r.json();
            const arr = (Array.isArray(j) ? j : []).filter(x => x && x.urls);
            if (arr.length) { turn.push(...arr); ICE_CACHE = { k: ck, t: Date.now(), v: arr }; }
            else error = 'Metered에서 TURN 정보를 받지 못했습니다';
          }
        } catch (e) {
          error = e && e.name === 'AbortError' ? 'Metered 응답 시간 초과' : 'Metered에 접속하지 못했습니다';
        } finally { clearTimeout(to); }
      }
    }
    const url = (s.turnUrl || '').trim();
    if (url) turn.push({ urls: url.split(',').map(x => x.trim()).filter(Boolean), username: s.turnUser || '', credential: s.turnPass || '' });
    turn.push(...CFG.turnServers);
    const hasTurn = turn.some(x => [].concat(x.urls).some(u => /^turns?:/i.test(u)));
    const cfg = { iceServers: iceServers.concat(turn) };
    if (s.forceRelay && hasTurn) cfg.iceTransportPolicy = 'relay';
    return { cfg, hasTurn, error };
  }
  function peerOptions(cfg) {
    const o = { config: cfg, debug: 0 };
    if (CFG.peerServer) Object.assign(o, CFG.peerServer);
    return o;
  }
  function routeFromStats(st) {
    let pair = null, pid = null;
    st.forEach(r => { if (r.type === 'transport' && r.selectedCandidatePairId) pid = r.selectedCandidatePairId; });
    if (pid) pair = st.get(pid);
    if (!pair) st.forEach(r => {
      if (!pair && r.type === 'candidate-pair' && r.state === 'succeeded' && (r.selected || r.nominated)) pair = r;
    });
    if (!pair) return '';
    const l = st.get(pair.localCandidateId), rm = st.get(pair.remoteCandidateId);
    return ((l && l.candidateType === 'relay') || (rm && rm.candidateType === 'relay')) ? 'relay' : 'direct';
  }
  async function getRoute(pc) {
    if (!pc || !pc.getStats) return '';
    try { return routeFromStats(await pc.getStats()); } catch (e) { return ''; }
  }

  /* ---------- 화면 꺼짐 방지 ---------- */
  let wakeLock = null, wantWake = false;
  async function acquireWake() {
    if (!wantWake || wakeLock || document.visibilityState !== 'visible') return;
    try {
      if ('wakeLock' in navigator) {
        wakeLock = await navigator.wakeLock.request('screen');
        wakeLock.addEventListener('release', () => { wakeLock = null; });
      }
    } catch (e) { wakeLock = null; }
  }
  function releaseWake() {
    wantWake = false;
    try { if (wakeLock) wakeLock.release(); } catch (e) {}
    wakeLock = null;
  }

  /* =========================================================
   *  화면 전환
   * ========================================================= */
  const screens = { home: $('home'), server: $('server'), client: $('client') };
  let current = 'home';
  function go(name, push = true) {
    current = name;
    for (const k in screens) show(screens[k], k === name);
    if (push && name !== 'home') { try { history.pushState({ s: name }, ''); } catch (e) {} }
    if (name === 'home') renderNetState();
    window.scrollTo(0, 0);
  }
  window.addEventListener('popstate', () => {
    if (S.running) { try { history.pushState({ s: 'server' }, ''); } catch (e) {} toast('송출 중입니다. [송출 종료]로 끝내 주세요.'); return; }
    if (C.want) { try { history.pushState({ s: 'client' }, ''); } catch (e) {} toast('시청 중입니다. [연결 종료]로 끝내 주세요.'); return; }
    if (current !== 'home') go('home', false);
  });
  window.addEventListener('beforeunload', e => {
    if (S.running || C.want) { e.preventDefault(); e.returnValue = ''; }
  });

  $('btnServerMode').onclick = () => go('server');
  $('btnClientMode').onclick = () => { go('client'); renderJoin(); };
  $('btnHome').onclick = () => {
    if (S.running) { if (!confirm('송출을 종료하고 처음 화면으로 갈까요?')) return; stopServer(); }
    if (C.want) { if (!confirm('시청을 종료하고 처음 화면으로 갈까요?')) return; leaveClient(); }
    go('home', false);
  };

  function renderNetState() {
    const box = $('netState');
    box.textContent = '';
    const ok = turnConfigured();
    box.className = 'net ' + (ok ? 'ok' : 'warn');
    box.append(el('span', 'ic', ok ? '✓' : '⚠'));
    const t = el('span');
    if (ok) {
      t.textContent = 'LTE 연결 준비됨 · 서로 다른 망에서도 TURN 중계로 연결할 수 있습니다.';
    } else {
      t.append('같은 와이파이에서는 바로 연결됩니다. LTE 등 다른 망에서 쓰려면 ');
      const a = el('button', 'link', 'TURN 설정');
      a.type = 'button'; a.onclick = openSettings;
      t.append(a, '이 필요할 수 있습니다.');
    }
    box.append(t);
  }

  /* =========================================================
   *  화면 어둡게
   * ========================================================= */
  const D = { on: false, kind: '', timer: null };
  function enterDim(kind) {
    D.on = true; D.kind = kind;
    show($('dim'), true);
    updateDim();
    clearInterval(D.timer); D.timer = setInterval(updateDim, 20000);
  }
  function exitDim() {
    if (!D.on) return;
    D.on = false; show($('dim'), false); clearInterval(D.timer);
  }
  function updateDim() {
    $('dimClock').textContent = hhmm();
    let t;
    if (D.kind === 'server') t = '송출 중 · 시청 ' + S.viewers.size + '대';
    else t = C.streamOn ? '시청 중 · 소리 알림 ' + (A.enabled ? '켜짐' : '꺼짐') : '연결 확인 중';
    $('dimText').textContent = t + ' · 화면을 누르면 돌아갑니다';
    const x = Math.round((Math.random() - .5) * 60), y = Math.round((Math.random() - .5) * 160);
    $('dimInner').style.transform = 'translate(' + x + 'px,' + y + 'px)';
  }
  $('dim').onclick = exitDim;

  /* =========================================================
   *  카메라 폰 (송출)
   * ========================================================= */
  const S = {
    peer: null, stream: null, code: '', running: false, facing: 'environment',
    viewers: new Map(), pending: new Map(), trusted: new Set(),
    ice: null, tick: null, recoverTimer: null, battery: null, mediaBusy: false, showQr: false
  };
  const AUDIO_C = { echoCancellation: false, noiseSuppression: false, autoGainControl: true };
  const videoC = face => ({ facingMode: { ideal: face }, width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 20, max: 24 } });

  function setS(state, pill, text) {
    $('sDot').className = 'dot ' + (state || '');
    $('sPill').textContent = pill;
    if (text != null) $('sStatus').textContent = text;
  }
  function loadServerState() {
    const s = store.get('server', null);
    if (s && typeof s.code === 'string' && s.code.length === CODE_LEN) {
      S.code = s.code;
      S.trusted = new Set(Array.isArray(s.trusted) ? s.trusted : []);
    } else newCode();
  }
  function saveServerState() { store.set('server', { code: S.code, trusted: [...S.trusted].slice(-20) }); }
  function newCode() { S.code = genCode(); S.trusted = new Set(); saveServerState(); }
  function mediaErrText(e) {
    const n = e && e.name;
    if (n === 'NotAllowedError' || n === 'SecurityError') return '카메라·마이크 권한이 거부되었습니다. 브라우저 설정에서 이 사이트의 권한을 허용해 주세요.';
    if (n === 'NotFoundError' || n === 'OverconstrainedError') return '사용할 수 있는 카메라나 마이크를 찾지 못했습니다.';
    if (n === 'NotReadableError') return '다른 앱이 카메라를 사용 중입니다. 다른 앱을 닫고 다시 시도해 주세요.';
    return '카메라를 켤 수 없습니다. (' + (n || '알 수 없는 오류') + ')';
  }
  function gum(c) { return navigator.mediaDevices.getUserMedia(c); }
  function watchTracks(stream) {
    stream.getTracks().forEach(t => t.addEventListener('ended', () => { if (S.running) setTimeout(() => recoverMedia(), 500); }));
  }
  function updateMirror() { $('sStage').classList.toggle('mirror', S.facing === 'user'); }

  document.querySelectorAll('#segFacing button').forEach(b => {
    b.onclick = () => {
      S.facing = b.dataset.v;
      document.querySelectorAll('#segFacing button').forEach(x => x.classList.toggle('on', x === b));
    };
  });

  $('btnStart').onclick = startServer;
  async function startServer() {
    if (S.running) return;
    if (!window.isSecureContext || !navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      setS('err', '오류', '카메라는 https:// 주소에서만 사용할 수 있습니다.'); return;
    }
    if (typeof Peer === 'undefined') { setS('err', '오류', '필요한 파일을 불러오지 못했습니다. 새로고침해 주세요.'); return; }
    $('btnStart').disabled = true;
    setS('wait', '준비', '카메라·마이크 권한을 요청하고 있습니다…');
    try {
      S.stream = await gum({ video: videoC(S.facing), audio: AUDIO_C });
    } catch (e) {
      // 마이크가 없는 기기 대비: 영상만이라도 시도
      try { S.stream = await gum({ video: videoC(S.facing), audio: false }); toast('마이크를 사용할 수 없어 영상만 송출합니다'); }
      catch (e2) { $('btnStart').disabled = false; setS('err', '오류', mediaErrText(e)); return; }
    }
    watchTracks(S.stream);
    $('preview').srcObject = S.stream;
    updateMirror();
    S.running = true;
    wantWake = true; acquireWake();
    loadServerState();
    setS('wait', '준비', '연결 설정을 불러오는 중…');
    const ice = await getIceConfig();
    if (!S.running) return;
    S.ice = ice.cfg;
    if (ice.error) toast('TURN 설정 확인 필요: ' + ice.error, 4000);
    show($('sIdle'), false); show($('sRun'), true);
    renderCode(); renderPending(); renderViewers();
    openServerPeer(0);
    clearInterval(S.tick); S.tick = setInterval(serverTick, 5000);
    initBattery();
    $('btnStart').disabled = false;
  }

  function openServerPeer(attempt) {
    if (!S.running) return;
    setS('wait', '준비', attempt ? '접속 코드를 다시 등록하는 중… (' + attempt + '/5)' : '접속 코드를 등록하는 중…');
    const peer = new Peer(CFG.peerPrefix + S.code, peerOptions(S.ice));
    S.peer = peer;
    peer.on('open', () => { if (peer === S.peer) updateServerStatus(); });
    peer.on('connection', conn => { if (peer === S.peer) onViewerConn(conn); });
    peer.on('disconnected', () => {
      if (peer !== S.peer || !S.running) return;
      setS('wait', 'LIVE', '중계 서버와 연결이 끊겨 다시 연결하는 중… (시청 중인 영상은 유지됩니다)');
      scheduleServerRecover();
    });
    peer.on('error', err => {
      if (peer !== S.peer || !S.running) return;
      const t = err && err.type;
      if (t === 'unavailable-id') {
        // 새로고침 직후 이전 연결이 아직 남아 있는 경우: 잠시 후 같은 코드로 재시도
        try { peer.destroy(); } catch (e) {}
        if (attempt < 5) setTimeout(() => { if (S.running && S.peer === peer) openServerPeer(attempt + 1); }, 3000);
        else { newCode(); renderCode(); toast('이전 코드를 쓸 수 없어 새 코드를 만들었습니다', 4000); openServerPeer(0); }
        return;
      }
      if (t === 'peer-unavailable') return;
      if (t === 'browser-incompatible') { setS('err', '오류', '이 브라우저는 지원되지 않습니다. 최신 Chrome이나 Safari를 사용해 주세요.'); return; }
      setS('wait', 'LIVE', '네트워크 오류 · 다시 연결하는 중…');
      scheduleServerRecover();
    });
  }
  function scheduleServerRecover() {
    if (S.recoverTimer) return;
    S.recoverTimer = setTimeout(() => {
      S.recoverTimer = null;
      if (!S.running) return;
      const p = S.peer;
      if (!p || p.destroyed) openServerPeer(0);
      else if (p.disconnected) { try { p.reconnect(); } catch (e) {} setTimeout(() => { if (S.running && S.peer === p && p.disconnected) scheduleServerRecover(); }, 5000); }
    }, 3000);
  }

  function onViewerConn(conn) {
    if (!S.running) { try { conn.close(); } catch (e) {} return; }
    const helloTimer = setTimeout(() => { if (!conn._info) try { conn.close(); } catch (e) {} }, 15000);
    conn.on('data', msg => {
      if (!msg || typeof msg !== 'object') return;
      if (msg.type === 'hello' && !conn._info) {
        clearTimeout(helloTimer);
        const info = {
          conn,
          deviceId: String(msg.deviceId || conn.peer).slice(0, 40),
          name: String(msg.name || '알 수 없는 기기').replace(/\s+/g, ' ').trim().slice(0, 24) || '알 수 없는 기기',
          quality: QUALITY[msg.quality] ? msg.quality : 'mid'
        };
        conn._info = info;
        // 같은 기기의 이전 연결이 남아 있으면 정리
        for (const [id, v] of S.viewers) if (v.deviceId === info.deviceId && id !== conn.peer) dropViewer(id);
        for (const [id, p] of S.pending) if (p.deviceId === info.deviceId && id !== conn.peer) S.pending.delete(id);
        if (S.viewers.size >= MAX_VIEWERS) { send(conn, { type: 'full' }); setTimeout(() => { try { conn.close(); } catch (e) {} }, 400); return; }
        if (S.trusted.has(info.deviceId)) approve(info, true);
        else {
          S.pending.set(conn.peer, info);
          exitDim(); vibrate([200, 100, 200]);
          renderPending();
          $('pendingCard').scrollIntoView({ behavior: 'smooth', block: 'center' });
        }
      } else if (msg.type === 'quality') {
        const v = S.viewers.get(conn.peer);
        if (v && QUALITY[msg.quality]) { v.quality = msg.quality; applyQualityWhenReady(v.call, v.quality); renderViewers(); }
      }
    });
    const gone = () => { clearTimeout(helloTimer); if (S.pending.delete(conn.peer)) renderPending(); dropViewer(conn.peer); };
    conn.on('close', gone);
    conn.on('error', gone);
  }

  function approve(info, auto) {
    const id = info.conn.peer;
    S.pending.delete(id);
    if (!S.running || !S.peer || !S.stream || !info.conn.open) { renderPending(); return; }
    let call = null;
    try { call = S.peer.call(id, S.stream); } catch (e) {}
    if (!call) { renderPending(); toast('연결하지 못했습니다'); return; }
    send(info.conn, { type: 'allow' });
    const v = Object.assign({}, info, { call, route: '' });
    S.viewers.set(id, v);
    S.trusted.add(info.deviceId); saveServerState();
    applyQualityWhenReady(call, v.quality);
    call.on('close', () => dropViewer(id));
    call.on('error', () => dropViewer(id));
    renderPending(); renderViewers(); updateServerStatus();
    toast(info.name + (auto ? ' 자동 연결됨' : ' 연결됨'));
    setTimeout(() => send(info.conn, statusMsg()), 800);
  }
  function deny(id) {
    const info = S.pending.get(id);
    S.pending.delete(id);
    if (info) { send(info.conn, { type: 'deny' }); setTimeout(() => { try { info.conn.close(); } catch (e) {} }, 400); }
    renderPending();
  }
  function kick(id) {
    const v = S.viewers.get(id);
    if (!v) return;
    if (!confirm('‘' + v.name + '’ 연결을 끊을까요? 다시 접속하려면 새로 허용해야 합니다.')) return;
    S.trusted.delete(v.deviceId); saveServerState();
    send(v.conn, { type: 'kicked' });
    setTimeout(() => dropViewer(id), 300);
  }
  function dropViewer(id) {
    const v = S.viewers.get(id);
    if (!v) return;
    S.viewers.delete(id);
    try { v.call.close(); } catch (e) {}
    try { v.conn.close(); } catch (e) {}
    renderViewers(); updateServerStatus();
  }

  function applyQualityWhenReady(call, q) {
    const tryApply = n => {
      const pc = call && call.peerConnection;
      const ready = pc && (pc.connectionState === 'connected' || pc.iceConnectionState === 'connected' || pc.iceConnectionState === 'completed');
      if (ready) setQuality(pc, q);
      else if (n < 80) setTimeout(() => tryApply(n + 1), 500);
    };
    tryApply(0);
  }
  async function setQuality(pc, q) {
    const p = QUALITY[q] || QUALITY.mid;
    for (const sn of pc.getSenders()) {
      if (!sn.track || !sn.getParameters) continue;
      try {
        const prm = sn.getParameters();
        if (!prm.encodings || !prm.encodings.length) continue;
        if (sn.track.kind === 'video') {
          const st = sn.track.getSettings ? sn.track.getSettings() : {};
          const short = Math.min(st.width || 720, st.height || 720);
          prm.encodings[0].maxBitrate = p.bitrate;
          prm.encodings[0].maxFramerate = p.fps;
          prm.encodings[0].scaleResolutionDownBy = Math.max(1, short / p.h);
          prm.degradationPreference = 'maintain-resolution'; // 아기 모니터는 부드러움보다 선명도 우선
        } else {
          prm.encodings[0].maxBitrate = 40000;
        }
        await sn.setParameters(prm);
      } catch (e) {}
    }
  }
  function replaceTracks(call, stream) {
    const pc = call && call.peerConnection;
    if (!pc || !pc.getTransceivers) return;
    pc.getTransceivers().forEach(tr => {
      const kind = tr.receiver && tr.receiver.track && tr.receiver.track.kind;
      const nt = kind === 'video' ? stream.getVideoTracks()[0] : kind === 'audio' ? stream.getAudioTracks()[0] : null;
      if (nt && tr.sender) tr.sender.replaceTrack(nt).catch(() => {});
    });
  }

  async function recoverMedia() {
    if (!S.running || S.mediaBusy) return;
    if (S.stream && !S.stream.getTracks().some(t => t.readyState === 'ended')) return;
    S.mediaBusy = true;
    try {
      let ns;
      try { ns = await gum({ video: videoC(S.facing), audio: AUDIO_C }); }
      catch (e) { ns = await gum({ video: videoC(S.facing), audio: false }); }
      const old = S.stream;
      S.stream = ns; watchTracks(ns);
      $('preview').srcObject = ns;
      S.viewers.forEach(v => { replaceTracks(v.call, ns); applyQualityWhenReady(v.call, v.quality); });
      if (old) old.getTracks().forEach(t => t.stop());
      updateServerStatus();
    } catch (e) {
      setS('err', '오류', '카메라가 꺼졌습니다. 화면을 켜고 이 페이지로 돌아오면 다시 켜집니다.');
    } finally { S.mediaBusy = false; }
  }

  $('btnFlip').onclick = async () => {
    if (!S.running || S.mediaBusy || !S.stream) return;
    S.mediaBusy = true;
    const next = S.facing === 'environment' ? 'user' : 'environment';
    const old = S.stream.getVideoTracks()[0];
    try {
      if (old) old.stop(); // 일부 안드로이드는 두 카메라를 동시에 열 수 없음
      let ns;
      try { ns = await gum({ video: videoC(next) }); S.facing = next; }
      catch (e) { ns = await gum({ video: videoC(S.facing) }); toast('카메라를 전환할 수 없습니다'); }
      const nt = ns.getVideoTracks()[0];
      watchTracks(ns);
      if (old) S.stream.removeTrack(old);
      S.stream.addTrack(nt);
      $('preview').srcObject = null; $('preview').srcObject = S.stream;
      S.viewers.forEach(v => { replaceTracks(v.call, S.stream); applyQualityWhenReady(v.call, v.quality); });
      updateMirror();
    } catch (e) {
      toast('카메라를 다시 켜지 못했습니다');
    } finally { S.mediaBusy = false; }
  };

  function statusMsg() {
    const b = S.battery;
    return {
      type: 'status',
      battery: b ? Math.round(b.level * 100) : null,
      charging: b ? !!b.charging : null,
      hidden: document.visibilityState !== 'visible'
    };
  }
  function broadcast(msg) { S.viewers.forEach(v => send(v.conn, msg)); }
  async function serverTick() {
    if (!S.running) return;
    broadcast(statusMsg());
    if (S.stream && S.stream.getTracks().some(t => t.readyState === 'ended')) recoverMedia();
    let changed = false;
    for (const v of S.viewers.values()) {
      const r = await getRoute(v.call.peerConnection);
      if (r && r !== v.route) { v.route = r; changed = true; }
    }
    if (changed) renderViewers();
    if (D.on && D.kind === 'server') updateDim();
  }
  function updateServerStatus() {
    if (!S.running) return;
    const p = S.peer;
    if (!p || p.destroyed || p.disconnected || !p.open) return;
    const n = S.viewers.size;
    setS('on', 'LIVE', n ? '송출 중 · ' + n + '대가 보고 있습니다.' : '송출 중 · 보는 폰의 접속을 기다리고 있습니다.');
    $('sCorner').textContent = n ? '👀 ' + n : '';
  }

  function initBattery() {
    if (S.battery || !navigator.getBattery) { renderBattery(); return; }
    navigator.getBattery().then(b => {
      S.battery = b; renderBattery();
      const on = () => { renderBattery(); broadcast(statusMsg()); };
      b.addEventListener('levelchange', on); b.addEventListener('chargingchange', on);
    }).catch(() => {});
  }
  function renderBattery() {
    const b = S.battery, t = $('sBattery');
    if (!b) { t.textContent = ''; return; }
    const lv = Math.round(b.level * 100);
    t.textContent = '배터리 ' + lv + '%' + (b.charging ? ' · 충전 중' : ' · 충전기를 연결해 두는 것을 권장합니다');
    t.style.color = !b.charging && lv <= 20 ? 'var(--bad)' : '';
  }

  function renderCode() {
    $('codeBox').textContent = fmtCode(S.code);
    renderQr();
  }
  const shareUrl = () => location.origin + location.pathname + '#c=' + S.code;
  function renderQr() {
    const box = $('qrBox');
    show(box, S.showQr);
    $('btnQr').textContent = S.showQr ? 'QR 숨기기' : 'QR 코드';
    if (!S.showQr) return;
    try {
      const qr = qrcode(0, 'M');
      qr.addData(shareUrl());
      qr.make();
      box.innerHTML = qr.createSvgTag({ cellSize: 4, margin: 2, scalable: true });
    } catch (e) { box.textContent = 'QR 코드를 만들 수 없습니다'; }
  }
  $('btnQr').onclick = () => { S.showQr = !S.showQr; renderQr(); };
  $('btnShare').onclick = async () => {
    const url = shareUrl();
    const text = '베이비캠 접속 코드: ' + fmtCode(S.code);
    if (navigator.share) {
      try { await navigator.share({ title: '베이비캠', text, url }); return; }
      catch (e) { if (e && e.name === 'AbortError') return; }
    }
    try { await navigator.clipboard.writeText(url); toast('링크를 복사했습니다'); }
    catch (e) { prompt('아래 링크를 복사하세요', url); }
  };
  $('btnNewCode').onclick = () => {
    if (!confirm('새 코드를 만들면 지금 보고 있는 기기의 연결이 끊기고, 다시 허용해야 합니다. 계속할까요?')) return;
    [...S.viewers.keys()].forEach(id => { const v = S.viewers.get(id); send(v.conn, { type: 'kicked' }); setTimeout(() => dropViewer(id), 300); });
    S.pending.clear(); renderPending();
    newCode(); renderCode();
    const old = S.peer; S.peer = null;
    setTimeout(() => { try { if (old) old.destroy(); } catch (e) {} openServerPeer(0); }, 500);
  };
  $('btnSDim').onclick = () => enterDim('server');
  $('btnStop').onclick = () => { if (confirm('송출을 종료할까요?')) stopServer(); };

  function renderPending() {
    const box = $('pendingList');
    box.textContent = '';
    show($('pendingCard'), S.pending.size > 0);
    S.pending.forEach((info, id) => {
      const d = el('div', 'item');
      const meta = el('div', 'meta');
      meta.append(el('strong', '', info.name), el('span', '', '영상을 보려고 합니다'));
      const btns = el('div', 'btns');
      const ok = el('button', 'btn sm ok', '허용'); ok.type = 'button'; ok.onclick = () => approve(info, false);
      const no = el('button', 'btn sm sec', '거부'); no.type = 'button'; no.onclick = () => deny(id);
      btns.append(no, ok);
      d.append(meta, btns);
      box.append(d);
    });
  }
  function renderViewers() {
    const box = $('viewerList');
    box.textContent = '';
    $('viewerCount').textContent = S.viewers.size;
    if (!S.viewers.size) { box.append(el('p', 'empty', '아직 연결된 기기가 없습니다.')); return; }
    S.viewers.forEach((v, id) => {
      const d = el('div', 'item');
      const meta = el('div', 'meta');
      const parts = [(QUALITY[v.quality] || QUALITY.mid).label + ' 화질'];
      if (v.route) parts.unshift(ROUTE_LABEL[v.route]);
      meta.append(el('strong', '', v.name), el('span', '', parts.join(' · ')));
      const b = el('button', 'btn sm bad', '끊기'); b.type = 'button'; b.onclick = () => kick(id);
      d.append(meta, b);
      box.append(d);
    });
  }

  function stopServer() {
    S.running = false;
    clearInterval(S.tick); clearTimeout(S.recoverTimer); S.recoverTimer = null;
    releaseWake(); exitDim();
    S.viewers.forEach(v => { send(v.conn, { type: 'stopped' }); });
    const viewers = [...S.viewers.values()];
    S.viewers.clear(); S.pending.clear();
    const peer = S.peer; S.peer = null;
    setTimeout(() => {
      viewers.forEach(v => { try { v.call.close(); } catch (e) {} try { v.conn.close(); } catch (e) {} });
      try { if (peer) peer.destroy(); } catch (e) {}
    }, 300);
    if (S.stream) { S.stream.getTracks().forEach(t => t.stop()); S.stream = null; }
    $('preview').srcObject = null;
    $('sCorner').textContent = '';
    show($('sRun'), false); show($('sIdle'), true);
    renderPending(); renderViewers();
    setS('', '대기', '송출을 시작하면 접속 코드가 만들어집니다.');
  }

  /* =========================================================
   *  보는 폰 (시청)
   * ========================================================= */
  const C = {
    peer: null, conn: null, call: null, code: '', want: false, gen: 0,
    everConnected: false, streamOn: false, paused: false, retry: 0, retryTimer: null, stepTimer: null,
    statsTimer: null, lastSeen: 0, prevBytes: 0, prevT: 0, kbps: 0, bytesBase: 0, callBytes: 0, totalBytes: 0,
    route: '', res: 0, server: null, hasTurn: false,
    quality: QUALITY[store.get('quality', '')] ? store.get('quality', '') : 'mid'
  };
  const remote = $('remote');

  function setC(state, pill, text) {
    $('cDot').className = 'dot ' + (state || '');
    $('cPill').textContent = pill;
    if (text != null) $('cStatus').textContent = text;
  }
  function setStale(on, text) {
    $('cStage').classList.toggle('stale', on);
    if (text) $('veilText').textContent = text;
  }
  function renderJoin() {
    $('myName').textContent = myName();
    const last = store.get('lastCode', '');
    const btn = $('btnRecent');
    if (last && last.length === CODE_LEN) { btn.textContent = '최근 코드로 연결 · ' + fmtCode(last); show(btn, true); }
    else show(btn, false);
  }

  const codeInput = $('codeInput');
  codeInput.addEventListener('input', () => {
    const v = cleanCode(codeInput.value);
    const f = fmtCode(v);
    if (codeInput.value !== f) codeInput.value = f;
  });
  codeInput.addEventListener('keydown', e => { if (e.key === 'Enter') $('btnConnect').click(); });
  $('btnConnect').onclick = () => {
    const code = cleanCode(codeInput.value);
    if (code.length !== CODE_LEN) { toast('8자리 코드를 입력해 주세요'); codeInput.focus(); return; }
    startClient(code);
  };
  $('btnRecent').onclick = () => { const c = store.get('lastCode', ''); if (c) { codeInput.value = fmtCode(c); startClient(c); } };
  $('btnRetry').onclick = () => { if (C.code) startClient(C.code); };
  $('btnLeave').onclick = () => { leaveClient(); };

  function startClient(code) {
    if (typeof Peer === 'undefined') { toast('필요한 파일을 불러오지 못했습니다. 새로고침해 주세요.'); return; }
    ensureAudio(); // 사용자 터치 시점에 오디오 준비 (iOS)
    clearTimeout(C.retryTimer);
    C.code = code; C.want = true; C.everConnected = false; C.retry = 0;
    C.bytesBase = 0; C.callBytes = 0; C.totalBytes = 0; C.server = null; C.route = ''; C.res = 0; C.kbps = 0; C.paused = false;
    store.set('lastCode', code);
    show($('cJoin'), false); show($('cView'), true); show($('btnRetry'), false);
    $('cInfo').textContent = '';
    setStale(true, '카메라 폰을 찾는 중…');
    wantWake = true; acquireWake();
    connectClient();
  }

  async function connectClient() {
    clearTimeout(C.retryTimer); C.retryTimer = null;
    teardownClientConn();
    const gen = ++C.gen, code = C.code;
    if (!C.everConnected) setC('wait', '연결 중', '카메라 폰을 찾는 중…');
    const ice = await getIceConfig();
    if (!C.want || gen !== C.gen) return;
    C.hasTurn = ice.hasTurn;
    let peer;
    try { peer = new Peer(peerOptions(ice.cfg)); }
    catch (e) { endClient('이 브라우저는 지원되지 않습니다. 최신 Chrome이나 Safari를 사용해 주세요.'); return; }
    C.peer = peer;
    const serverId = CFG.peerPrefix + code;
    C.stepTimer = setTimeout(() => handleDrop('timeout', peer), 25000);

    peer.on('open', () => {
      if (peer !== C.peer) return;
      const conn = peer.connect(serverId, { reliable: true, serialization: 'json' });
      C.conn = conn;
      conn.on('open', () => {
        if (peer !== C.peer) return;
        clearTimeout(C.stepTimer);
        C.lastSeen = Date.now();
        send(conn, { type: 'hello', v: 2, deviceId: DEVICE_ID, name: myName(), quality: C.quality });
        if (!C.everConnected) {
          setC('wait', '승인 대기', '카메라 폰에서 ‘허용’을 누르면 연결됩니다.');
          setStale(true, '카메라 폰의 허용을 기다리는 중…');
        }
      });
      conn.on('data', m => onClientMsg(m, peer));
      conn.on('close', () => handleDrop('closed', peer));
      conn.on('error', () => handleDrop('closed', peer));
    });
    peer.on('call', call => {
      if (peer !== C.peer) return;
      if (call.peer !== serverId) { try { call.close(); } catch (e) {} return; }
      C.call = call;
      call.answer();
      call.on('stream', s => onStream(s, peer));
      call.on('close', () => handleDrop('closed', peer));
      call.on('error', () => handleDrop('failed', peer));
      watchPc(call, peer);
    });
    peer.on('disconnected', () => {
      if (peer !== C.peer) return;
      setTimeout(() => { try { if (peer === C.peer && peer.disconnected && !peer.destroyed) peer.reconnect(); } catch (e) {} }, 2000);
    });
    peer.on('error', err => {
      if (peer !== C.peer) return;
      const t = err && err.type;
      if (t === 'peer-unavailable') handleDrop('notfound', peer);
      else if (t === 'browser-incompatible') endClient('이 브라우저는 지원되지 않습니다. 최신 Chrome이나 Safari를 사용해 주세요.');
      else if (C.streamOn && (t === 'network' || t === 'server-error' || t === 'socket-error' || t === 'socket-closed' || t === 'disconnected')) { /* 영상은 계속 */ }
      else handleDrop('error', peer);
    });
  }

  function watchPc(call, peer) {
    const attach = n => {
      const pc = call.peerConnection;
      if (!pc) { if (n < 20) setTimeout(() => attach(n + 1), 250); return; }
      let t = null;
      pc.addEventListener('iceconnectionstatechange', () => {
        if (peer !== C.peer) return;
        const s = pc.iceConnectionState;
        if (s === 'failed') handleDrop('failed', peer);
        else if (s === 'disconnected') {
          clearTimeout(t);
          setStale(true, '신호가 약합니다. 다시 연결하는 중…');
          t = setTimeout(() => { if (peer === C.peer && /disconnected|failed/.test(pc.iceConnectionState)) handleDrop('failed', peer); }, 8000);
        } else if (s === 'connected' || s === 'completed') {
          clearTimeout(t);
          if (C.streamOn && !C.paused) setStale(false);
        }
      });
    };
    attach(0);
  }

  function onClientMsg(m, peer) {
    if (peer !== C.peer || !m || typeof m !== 'object') return;
    C.lastSeen = Date.now();
    switch (m.type) {
      case 'allow':
        clearTimeout(C.stepTimer);
        if (!C.streamOn) { setC('wait', '연결 중', '영상 연결 중…'); setStale(true, '영상 연결 중…'); }
        C.stepTimer = setTimeout(() => { if (peer === C.peer && !C.streamOn) handleDrop('failed', peer); }, 30000);
        break;
      case 'deny': handleDrop('denied', peer); break;
      case 'kicked': handleDrop('kicked', peer); break;
      case 'full': handleDrop('full', peer); break;
      case 'stopped': handleDrop('stopped', peer); break;
      case 'status':
        C.server = { battery: m.battery, charging: m.charging };
        setPaused(!!m.hidden);
        renderInfo();
        break;
    }
  }

  function onStream(s, peer) {
    if (peer !== C.peer) return;
    clearTimeout(C.stepTimer);
    C.streamOn = true; C.everConnected = true; C.retry = 0; C.lastSeen = Date.now();
    C.bytesBase = C.totalBytes; C.callBytes = 0;
    remote.srcObject = s;
    const p = remote.play(); if (p && p.catch) p.catch(() => {});
    show($('btnRetry'), false);
    if (!C.paused) setStale(false);
    setC('on', 'LIVE', '시청 중');
    attachAnalyser(s);
    startStats();
  }

  function setPaused(on) {
    if (C.paused === on) return;
    C.paused = on;
    if (on) {
      setStale(true, '카메라 폰 화면이 꺼졌거나 다른 앱으로 전환되었습니다.\n카메라 폰을 확인해 주세요.');
      setC('wait', '일시 중지', '카메라 폰 화면이 꺼져 송출이 멈췄을 수 있습니다.');
    } else if (C.streamOn) {
      setStale(false); setC('on', 'LIVE', '시청 중');
    }
  }

  function handleDrop(reason, peer) {
    if (peer && peer !== C.peer) return;
    if (!C.want) return;
    const wasOn = C.streamOn;
    teardownClientConn();
    const msgs = {
      denied: '카메라 폰에서 접속을 거부했습니다.',
      kicked: '카메라 폰에서 연결을 해제했습니다.',
      full: '카메라 폰에 연결된 기기가 너무 많습니다. (최대 ' + MAX_VIEWERS + '대)',
      stopped: '카메라 폰에서 송출을 종료했습니다.'
    };
    if (msgs[reason]) { endClient(msgs[reason]); return; }
    if (reason === 'notfound' && !C.everConnected) {
      endClient('이 코드로 송출 중인 카메라 폰이 없습니다. 코드를 확인하거나 카메라 폰에서 송출을 시작해 주세요.'); return;
    }
    if (!C.everConnected && C.retry >= 2) {
      endClient(C.hasTurn
        ? '연결하지 못했습니다. 두 폰의 인터넷 연결을 확인한 뒤 다시 시도해 주세요.'
        : '연결하지 못했습니다. 서로 다른 망(LTE 등)이라면 설정에서 TURN 중계를 등록해야 할 수 있습니다.');
      return;
    }
    C.retry++;
    const delay = Math.min(15000, Math.round(1500 * Math.pow(1.6, C.retry - 1)));
    const txt = C.everConnected ? '연결이 끊겨 다시 연결하는 중… (' + C.retry + '회째)' : '다시 시도하는 중…';
    setC('wait', '재연결', txt);
    setStale(true, wasOn ? '연결이 끊겼습니다.\n자동으로 다시 연결하는 중…' : txt);
    if (wasOn && A.enabled) vibrate(80);
    C.retryTimer = setTimeout(() => { if (C.want) connectClient(); }, delay);
  }

  function endClient(msg) {
    C.want = false; C.gen++;
    clearTimeout(C.retryTimer);
    teardownClientConn();
    releaseWake();
    setC('err', '끊김', msg);
    setStale(true, msg);
    show($('btnRetry'), true);
  }
  function teardownClientConn() {
    clearTimeout(C.stepTimer);
    stopStats();
    C.streamOn = false;
    const { peer, call, conn } = C;
    C.peer = C.call = C.conn = null;
    try { if (call) call.close(); } catch (e) {}
    try { if (conn) conn.close(); } catch (e) {}
    try { if (peer) peer.destroy(); } catch (e) {}
    detachAnalyser();
  }
  function leaveClient() {
    C.want = false; C.gen++;
    clearTimeout(C.retryTimer);
    teardownClientConn();
    remote.srcObject = null;
    releaseWake(); exitDim(); exitFs();
    setC('', '대기', '');
    show($('cView'), false); show($('cJoin'), true);
    renderJoin();
  }

  /* ---------- 통계 ---------- */
  function startStats() { stopStats(); C.prevBytes = 0; C.prevT = 0; C.statsTimer = setInterval(collectStats, 2000); collectStats(); }
  function stopStats() { clearInterval(C.statsTimer); C.statsTimer = null; }
  async function collectStats() {
    const pc = C.call && C.call.peerConnection;
    if (!pc) return;
    if (C.streamOn && Date.now() - C.lastSeen > 25000) { handleDrop('timeout', C.peer); return; }
    let st;
    try { st = await pc.getStats(); } catch (e) { return; }
    let bytes = 0, w = 0, h = 0;
    st.forEach(r => {
      if (r.type === 'inbound-rtp') {
        bytes += r.bytesReceived || 0;
        if ((r.kind || r.mediaType) === 'video') { w = r.frameWidth || w; h = r.frameHeight || h; }
      }
    });
    if (!w && remote.videoWidth) { w = remote.videoWidth; h = remote.videoHeight; }
    const now = performance.now();
    if (C.prevT && bytes >= C.prevBytes) C.kbps = (bytes - C.prevBytes) * 8 / ((now - C.prevT) / 1000) / 1000;
    C.prevBytes = bytes; C.prevT = now;
    C.callBytes = bytes;
    C.totalBytes = C.bytesBase + bytes;
    C.route = routeFromStats(st) || C.route;
    C.res = w && h ? Math.min(w, h) : 0;
    renderInfo();
    if (D.on && D.kind === 'client') updateDim();
  }
  function renderInfo() {
    const box = $('cInfo');
    box.textContent = '';
    if (!C.everConnected) return;
    const add = (t, cls) => box.append(el('span', 'chip' + (cls ? ' ' + cls : ''), t));
    if (C.route) add(ROUTE_LABEL[C.route], C.route);
    if (C.res) add(C.res + 'p');
    if (C.kbps) add(Math.round(C.kbps) + ' kbps');
    add('사용 데이터 ' + fmtBytes(C.totalBytes));
    const s = C.server;
    if (s && s.battery != null) {
      add('카메라 폰 배터리 ' + s.battery + '%' + (s.charging ? ' ⚡' : ''), !s.charging && s.battery <= 20 ? 'low' : '');
    }
  }

  /* ---------- 화질 ---------- */
  function renderQuality() {
    document.querySelectorAll('#segQuality button').forEach(b => b.classList.toggle('on', b.dataset.v === C.quality));
    $('qualityHint').textContent = QUALITY[C.quality].hint;
  }
  document.querySelectorAll('#segQuality button').forEach(b => {
    b.onclick = () => {
      C.quality = b.dataset.v; store.set('quality', C.quality); renderQuality();
      send(C.conn, { type: 'quality', quality: C.quality });
    };
  });

  /* ---------- 소리·화면 ---------- */
  function renderMute() {
    $('btnMute').querySelector('.ti').textContent = remote.muted ? '🔇' : '🔊';
    $('btnMute').lastElementChild.textContent = remote.muted ? '소리 켜기' : '소리 끄기';
    $('btnMute').classList.toggle('on', !remote.muted);
  }
  $('btnMute').onclick = () => {
    remote.muted = !remote.muted;
    if (!remote.muted) { const p = remote.play(); if (p && p.catch) p.catch(() => {}); }
    ensureAudio();
    renderMute();
  };

  let fakeFs = false;
  function enterFs() {
    const st = $('cStage');
    const req = st.requestFullscreen || st.webkitRequestFullscreen;
    if (req && (document.fullscreenEnabled || document.webkitFullscreenEnabled)) {
      try {
        const p = req.call(st);
        if (p && p.catch) p.catch(() => setFake(true));
        try { screen.orientation && screen.orientation.lock && screen.orientation.lock('landscape').catch(() => {}); } catch (e) {}
      } catch (e) { setFake(true); }
    } else setFake(true);
  }
  function exitFs() {
    if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
    else if (document.webkitFullscreenElement) document.webkitExitFullscreen();
    setFake(false);
  }
  function setFake(on) { fakeFs = on; $('cStage').classList.toggle('fake-fs', on); document.body.style.overflow = on ? 'hidden' : ''; }
  $('btnFull').onclick = enterFs;
  $('btnFsClose').onclick = exitFs;

  const pipSupported = !!((document.pictureInPictureEnabled && remote.requestPictureInPicture) ||
    (remote.webkitSupportsPresentationMode && typeof remote.webkitSetPresentationMode === 'function'));
  if (!pipSupported) $('btnPip').disabled = true;
  $('btnPip').onclick = async () => {
    if (!remote.srcObject) { toast('영상이 연결된 뒤 사용할 수 있습니다'); return; }
    try {
      if (document.pictureInPictureEnabled && remote.requestPictureInPicture) {
        if (document.pictureInPictureElement) await document.exitPictureInPicture();
        else await remote.requestPictureInPicture();
      } else if (remote.webkitSetPresentationMode) {
        remote.webkitSetPresentationMode(remote.webkitPresentationMode === 'picture-in-picture' ? 'inline' : 'picture-in-picture');
      }
    } catch (e) { toast('작은 화면을 열 수 없습니다'); }
  };

  $('btnSnap').onclick = () => {
    if (!remote.videoWidth) { toast('영상이 연결된 뒤 사용할 수 있습니다'); return; }
    const c = document.createElement('canvas');
    c.width = remote.videoWidth; c.height = remote.videoHeight;
    c.getContext('2d').drawImage(remote, 0, 0);
    c.toBlob(b => {
      if (!b) { toast('사진을 저장하지 못했습니다'); return; }
      const d = new Date();
      const name = 'babycam-' + d.getFullYear() + pad(d.getMonth() + 1) + pad(d.getDate()) + '-' + pad(d.getHours()) + pad(d.getMinutes()) + pad(d.getSeconds()) + '.jpg';
      const url = URL.createObjectURL(b);
      const a = document.createElement('a'); a.href = url; a.download = name;
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 10000);
      toast('사진을 저장했습니다');
    }, 'image/jpeg', 0.92);
  };
  $('btnCDim').onclick = () => enterDim('client');

  /* =========================================================
   *  소리 감지 알림
   * ========================================================= */
  const A = {
    ctx: null, src: null, an: null, buf: null, timer: null, lastT: 0,
    enabled: !!store.get('alarm', false), sens: Number(store.get('sens', 55)) || 55,
    level: 0, loudMs: 0, lastAlert: 0, events: []
  };
  const threshold = () => Math.round(92 - A.sens * 0.72); // 민감도 1→91, 100→20

  function ensureAudio() {
    try {
      if (!A.ctx) { const AC = window.AudioContext || window.webkitAudioContext; if (AC) A.ctx = new AC(); }
      if (A.ctx && A.ctx.state !== 'running') A.ctx.resume().catch(() => {});
    } catch (e) {}
  }
  function attachAnalyser(stream) {
    detachAnalyser();
    if (!A.ctx || !stream.getAudioTracks().length) { renderMeterState(); return; }
    try {
      A.src = A.ctx.createMediaStreamSource(stream);
      A.an = A.ctx.createAnalyser(); A.an.fftSize = 1024;
      A.buf = new Uint8Array(A.an.fftSize);
      A.src.connect(A.an);
      A.lastT = performance.now(); A.loudMs = 0;
      A.timer = setInterval(audioTick, 100);
    } catch (e) { A.src = A.an = null; }
    renderMeterState();
  }
  function detachAnalyser() {
    clearInterval(A.timer); A.timer = null;
    try { if (A.src) A.src.disconnect(); } catch (e) {}
    A.src = A.an = null; A.level = 0;
    $('meterFill').style.width = '0%';
  }
  function audioTick() {
    if (!A.an) return;
    if (A.ctx && A.ctx.state === 'suspended') A.ctx.resume().catch(() => {});
    A.an.getByteTimeDomainData(A.buf);
    let sum = 0;
    for (let i = 0; i < A.buf.length; i++) { const v = (A.buf[i] - 128) / 128; sum += v * v; }
    const db = 20 * Math.log10(Math.sqrt(sum / A.buf.length) + 1e-8);
    const lv = Math.max(0, Math.min(100, (db + 65) / 55 * 100));
    A.level = A.level * 0.55 + lv * 0.45;
    const now = performance.now(), dt = Math.min(1500, now - A.lastT); A.lastT = now;
    const th = threshold(), loud = A.level >= th;
    const f = $('meterFill');
    f.style.width = A.level.toFixed(1) + '%';
    f.classList.toggle('loud', A.enabled && loud);
    if (!A.enabled || !C.streamOn) { A.loudMs = 0; return; }
    A.loudMs = loud ? A.loudMs + dt : Math.max(0, A.loudMs - dt * 0.5);
    if (A.loudMs >= 1000 && Date.now() - A.lastAlert > 20000) { A.loudMs = 0; fireAlarm(); }
  }
  function fireAlarm() {
    A.lastAlert = Date.now();
    A.events.unshift(hhmm()); A.events = A.events.slice(0, 8);
    renderEvents();
    exitDim();
    const banner = $('alarmBanner');
    banner.textContent = '🔔 소리 감지 ' + hhmm();
    show(banner, true);
    clearTimeout(A.bannerT); A.bannerT = setTimeout(() => show(banner, false), 8000);
    vibrate([400, 150, 400, 150, 400]);
    beep();
    try {
      if (document.visibilityState !== 'visible' && 'Notification' in window && Notification.permission === 'granted') {
        new Notification('베이비캠', { body: hhmm() + ' 아기 방에서 소리가 감지되었습니다.', icon: 'icon.svg', tag: 'babycam-alarm', renotify: true });
      }
    } catch (e) {}
  }
  function beep() {
    if (!A.ctx) return;
    try {
      const t0 = A.ctx.currentTime + 0.02;
      for (let i = 0; i < 3; i++) {
        const o = A.ctx.createOscillator(), g = A.ctx.createGain();
        o.type = 'sine'; o.frequency.value = i === 1 ? 988 : 880;
        const t = t0 + i * 0.32;
        g.gain.setValueAtTime(0.0001, t);
        g.gain.exponentialRampToValueAtTime(0.35, t + 0.02);
        g.gain.exponentialRampToValueAtTime(0.0001, t + 0.24);
        o.connect(g); g.connect(A.ctx.destination);
        o.start(t); o.stop(t + 0.26);
      }
    } catch (e) {}
  }
  function renderEvents() {
    const box = $('events');
    box.textContent = '';
    if (A.events.length) box.append(el('span', 'tiny', '최근 감지'));
    A.events.forEach(t => box.append(el('span', 'chip', t)));
  }
  function renderMeterState() {
    const th = threshold();
    $('meterMark').style.left = th + '%';
    $('cStage').querySelector('.meter').classList.toggle('off', !A.enabled);
    $('sensVal').textContent = A.sens;
    $('sens').value = A.sens;
    const btn = $('btnAlarm');
    btn.classList.toggle('on', A.enabled);
    btn.lastElementChild.textContent = A.enabled ? '알림 켜짐' : '소리 알림';
    $('alarmState').textContent = A.enabled
      ? '켜짐 · 이 화면을 켜 둔 상태에서 아기 방 소리가 커지면 알려 줍니다.'
      : '꺼짐 · 위의 [소리 알림]을 눌러 켤 수 있습니다.';
  }
  $('btnAlarm').onclick = () => {
    A.enabled = !A.enabled; store.set('alarm', A.enabled);
    ensureAudio();
    if (A.enabled && 'Notification' in window && Notification.permission === 'default') {
      try { Notification.requestPermission().catch(() => {}); } catch (e) {}
    }
    if (A.enabled && remote.srcObject && !A.an) attachAnalyser(remote.srcObject);
    renderMeterState();
    toast(A.enabled ? '소리 알림을 켰습니다' : '소리 알림을 껐습니다');
  };
  $('sens').addEventListener('input', e => {
    A.sens = Number(e.target.value) || 55; store.set('sens', A.sens); renderMeterState();
  });

  /* =========================================================
   *  설정
   * ========================================================= */
  function openSettings() {
    $('fName').value = settings.name || '';
    $('fName').placeholder = guessName();
    $('fMApp').value = settings.meteredApp || '';
    $('fMKey').value = settings.meteredKey || '';
    $('fTUrl').value = settings.turnUrl || '';
    $('fTUser').value = settings.turnUser || '';
    $('fTPass').value = settings.turnPass || '';
    $('fRelay').checked = !!settings.forceRelay;
    show($('cfgNotice'), !!((CFG.meteredApp && CFG.meteredApiKey) || CFG.turnServers.length));
    const r = $('testResult'); r.textContent = ''; r.className = 'tiny test-result';
    show($('settings'), true);
  }
  function readForm() {
    return {
      name: $('fName').value.trim().slice(0, 20),
      meteredApp: $('fMApp').value.trim().replace(/^https?:\/\//, '').replace(/\/.*$/, '').replace(/\.metered\.live$/i, ''),
      meteredKey: $('fMKey').value.trim(),
      turnUrl: $('fTUrl').value.trim(),
      turnUser: $('fTUser').value.trim(),
      turnPass: $('fTPass').value,
      forceRelay: $('fRelay').checked
    };
  }
  function closeSettings() { show($('settings'), false); }
  $('btnSettings').onclick = openSettings;
  $('btnSetClose').onclick = closeSettings;
  $('settings').addEventListener('click', e => { if (e.target === $('settings')) closeSettings(); });
  $('btnSetSave').onclick = () => {
    Object.assign(settings, readForm());
    store.set('settings', settings);
    ICE_CACHE = { k: '', t: 0, v: [] };
    closeSettings();
    renderNetState(); renderJoin();
    toast(S.running || C.want ? '저장했습니다. 다음 연결부터 적용됩니다.' : '저장했습니다');
  };
  $('btnTest').onclick = async () => {
    const r = $('testResult'), b = $('btnTest');
    r.className = 'tiny test-result'; r.textContent = '확인하는 중…'; b.disabled = true;
    try {
      const ice = await getIceConfig(readForm(), true);
      if (!ice.hasTurn) {
        r.className += ' bad';
        r.textContent = ice.error ? '✗ ' + ice.error + '. 앱 이름과 API Key를 확인해 주세요.' : '✗ 설정된 TURN 서버가 없습니다.';
        return;
      }
      const pc = new RTCPeerConnection({ iceServers: ice.cfg.iceServers, iceTransportPolicy: 'relay' });
      pc.createDataChannel('t');
      const found = new Promise(res => {
        const to = setTimeout(() => res(false), 9000);
        pc.onicecandidate = e => {
          if (e.candidate && /\btyp relay\b/.test(e.candidate.candidate)) { clearTimeout(to); res(true); }
          else if (!e.candidate) { clearTimeout(to); res(false); }
        };
      });
      await pc.setLocalDescription(await pc.createOffer());
      const ok = await found;
      pc.close();
      r.className += ok ? ' good' : ' bad';
      r.textContent = ok
        ? '✓ TURN 서버에 연결되었습니다. LTE 등 다른 망에서도 연결할 수 있습니다. [저장]을 눌러 주세요.'
        : '✗ TURN 서버에 연결하지 못했습니다. 정보를 확인하거나 다른 네트워크에서 다시 시도해 주세요.';
    } catch (e) {
      r.className += ' bad'; r.textContent = '✗ 테스트 중 오류가 발생했습니다.';
    } finally { b.disabled = false; }
  };

  /* =========================================================
   *  생명주기
   * ========================================================= */
  document.addEventListener('visibilitychange', () => {
    const vis = document.visibilityState === 'visible';
    if (vis) acquireWake();
    if (S.running) {
      broadcast(statusMsg());
      if (vis) { setTimeout(() => recoverMedia(), 300); if (S.peer && (S.peer.disconnected || S.peer.destroyed)) scheduleServerRecover(); }
    }
    if (vis && C.want) {
      ensureAudio();
      if (!C.streamOn && C.retryTimer) { clearTimeout(C.retryTimer); connectClient(); }
      else if (C.streamOn && Date.now() - C.lastSeen > 15000) handleDrop('timeout', C.peer);
    }
  });
  window.addEventListener('online', () => {
    if (S.running) scheduleServerRecover();
    if (C.want && !C.streamOn && C.retryTimer) { clearTimeout(C.retryTimer); connectClient(); }
  });
  document.addEventListener('fullscreenchange', () => { if (!document.fullscreenElement) { try { screen.orientation.unlock(); } catch (e) {} } });
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape') { if (fakeFs) setFake(false); if (D.on) exitDim(); if (!$('settings').classList.contains('hidden')) closeSettings(); }
  });

  /* =========================================================
   *  시작
   * ========================================================= */
  renderNetState(); renderQuality(); renderMute(); renderMeterState(); renderJoin(); renderViewers();
  if (!window.isSecureContext) {
    toast('https:// 주소로 접속해야 카메라를 사용할 수 있습니다', 5000);
  }
  function codeFromUrl() {
    const m = (location.hash + '&' + location.search).match(/[#?&]c=([A-Za-z0-9-]+)/);
    if (!m) return;
    const code = cleanCode(m[1]);
    if (code.length !== CODE_LEN) return;
    try { history.replaceState(null, '', location.pathname); } catch (e) {}
    if (S.running || C.want) return;
    go('client'); renderJoin();
    codeInput.value = fmtCode(code);
    toast('코드가 입력되었습니다. [연결]을 눌러 주세요.', 3500);
  }
  window.addEventListener('hashchange', codeFromUrl);
  codeFromUrl();
})();
