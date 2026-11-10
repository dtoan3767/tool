// ==UserScript==
// @name         Garena Auto Register (Speed v9.5)
// @namespace    http://tampermonkey.net/
// @version      9.5
// @description  Auto register Garena — no anti-simulation, max speed
// @match        https://sso.garena.com/universal/register*
// @match        https://sso.garena.com/universal/login*
// @grant        GM_xmlhttpRequest
// @grant        GM_setValue
// @grant        GM_getValue
// @connect      api.internal.temp-mail.io
// @connect      garena.com
// @run-at       document-end
// ==/UserScript==

(function () {
    'use strict';

    // ─── CONFIG KEYS ──────────────────────────────────────────────────────────
    const STORAGE_KEY       = 'garena_accounts';
    const AUTO_LOOP_KEY     = 'garena_auto_loop';
    const SESSION_COUNT_KEY = 'garena_session_count';
    const PENDING_KEY       = 'garena_pending';
    const CFG_EMAIL_PREFIX  = 'garena_cfg_email_prefix';
    const CFG_USER_PREFIX   = 'garena_cfg_user_prefix';
    const CFG_PASSWORD      = 'garena_cfg_password';

    const OTP_TIMEOUT_MS  = 120000;   // 2 phút — đủ dùng
    const RESEND_AFTER_MS = 15000;    // resend sau 15s
    const RESEND_CHECK_MS = 2000;
    const MAX_RESEND      = 8;
    const FIXED_DOMAINS   = ['gmeenramy.com', 'ruutukf.com'];
    let   domainIndex     = 0;

    // ─── STATE ────────────────────────────────────────────────────────────────
    let isRunning    = false;
    let navLoopTimer = null;

    // ─── UTILS ────────────────────────────────────────────────────────────────
    const sleep = ms => new Promise(r => setTimeout(r, ms));
    const rand  = (min, max) => Math.floor(Math.random() * (max - min + 1)) + min;

    // ─── STORAGE ──────────────────────────────────────────────────────────────
    function loadAccounts() {
        try { return JSON.parse(GM_getValue(STORAGE_KEY, '[]')); } catch { return []; }
    }
    function saveAccounts(list) { GM_setValue(STORAGE_KEY, JSON.stringify(list)); }
    function upsertAccount(acc) {
        const list = loadAccounts();
        const idx  = list.findIndex(a => a.email === acc.email);
        const now  = new Date().toISOString();
        if (idx >= 0) list[idx] = { ...list[idx], ...acc, updatedAt: now };
        else list.push({ email: acc.email, username: acc.username || '', password: acc.password || '', createdAt: now, updatedAt: now });
        saveAccounts(list);
    }

    // ─── CONFIG GET/SET ───────────────────────────────────────────────────────
    function getEmailPrefix() {
        const el = document.getElementById('garena-email-prefix');
        return (el?.value || GM_getValue(CFG_EMAIL_PREFIX, 'duytoan')).trim() || 'duytoan';
    }
    function getUserPrefix() {
        const el = document.getElementById('garena-user-prefix');
        return (el?.value || GM_getValue(CFG_USER_PREFIX, 'duytoan')).trim() || 'duytoan';
    }
    function getPassword() {
        const el = document.getElementById('garena-password');
        return (el?.value || GM_getValue(CFG_PASSWORD, '@Duytoan20009')).trim() || '@Duytoan20009';
    }
    function saveConfig() {
        GM_setValue(CFG_EMAIL_PREFIX, getEmailPrefix());
        GM_setValue(CFG_USER_PREFIX,  getUserPrefix());
        GM_setValue(CFG_PASSWORD,     getPassword());
    }

    // ─── GENERATORS ───────────────────────────────────────────────────────────
    function genUsername()  { return getUserPrefix()  + rand(1000, 99999); }
    function genLocalPart() { return getEmailPrefix() + rand(1000, 99999); }

    // ─── VISIBILITY ───────────────────────────────────────────────────────────
    function isVisible(el) {
        if (!el) return false;
        if (el.closest('#garena-auto-panel') || el.closest('#garena-auto-icon')) return false;
        const s = getComputedStyle(el);
        if (s.display === 'none' || s.visibility === 'hidden' || s.opacity === '0') return false;
        const r = el.getBoundingClientRect();
        return r.width > 0 && r.height > 0;
    }

    // ─── FAST FILL (thay humanType — không delay per-char) ────────────────────
    const nativeSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;

    async function fastFill(input, text) {
        input.focus();
        nativeSetter.call(input, text);
        input.dispatchEvent(new Event('input',  { bubbles: true }));
        input.dispatchEvent(new Event('change', { bubbles: true }));
        input.dispatchEvent(new Event('blur',   { bubbles: true }));
        await sleep(50);
    }

    // ─── FAST CLICK (thay humanClick — không mouse simulation) ────────────────
    async function fastClick(el) {
        if (!el) return false;
        el.scrollIntoView({ block: 'center' });
        await sleep(60);
        el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, button: 0 }));
        el.dispatchEvent(new MouseEvent('mouseup',   { bubbles: true, cancelable: true, button: 0 }));
        el.click();
        await sleep(60);
        return true;
    }

    // ─── HTTP ─────────────────────────────────────────────────────────────────
    function httpRequest(opts) {
        return new Promise((resolve, reject) => {
            GM_xmlhttpRequest({
                ...opts,
                onload:  r => { try { resolve(JSON.parse(r.responseText)); } catch { resolve(r.responseText); } },
                onerror: e => reject(new Error(e.message || 'Network Error'))
            });
        });
    }

    async function createMailWithDomain(domain) {
        const local = genLocalPart();
        const email = `${local}@${domain}`;
        try {
            const res = await httpRequest({
                method: 'POST',
                url: 'https://api.internal.temp-mail.io/api/v3/email/new',
                headers: { 'Content-Type': 'application/json', 'User-Agent': navigator.userAgent },
                data: JSON.stringify({ name: local, domain: domain })
            });
            if (res && res.email && res.email.endsWith('@' + domain)) return { email: res.email };
            return { email };
        } catch (e) { console.warn('[temp-mail] create fail:', e); return { email }; }
    }

    // ─── OTP EXTRACT ──────────────────────────────────────────────────────────
    function extractOtp(text) {
        const pats = [
            />[ \t]*(\d{8})[ \t]*<\//,
            /(?:mã xác (?:minh|nhận)|mã otp|mã của bạn)[^0-9]{0,40}(\d{8})/i,
            /(?:verification code|your code|otp code|the code)[^0-9]{0,40}(\d{8})/i,
            /(?:^|[\n\r])[ \t]*(\d{8})[ \t]*(?:[\n\r]|$)/m,
            /["'\[\(](\d{8})["'\]\)]/,
        ];
        for (const re of pats) {
            const m = text.match(re);
            if (m) return m[1];
        }
        return null;
    }

    function findSendCodeBtn() {
        return Array.from(document.querySelectorAll('button,[role="button"]')).find(b => {
            const t = (b.textContent || b.innerText).toUpperCase().trim();
            return (t === 'NHẬN MÃ' || t.includes('NHẬN MÃ') || t.includes('GỬI MÃ') || t.includes('GỬI LẠI') || t.includes('RESEND')) &&
                   isVisible(b) && !b.disabled;
        }) || null;
    }

    // ─── OTP POLL + RESEND ────────────────────────────────────────────────────
    async function pollOtpWithResend(email) {
        const start       = Date.now();
        let   lastSendAt  = Date.now();
        let   resendCount = 0;
        let   otpFound    = null;
        let   done        = false;

        const resendWatcher = setInterval(async () => {
            if (done || resendCount >= MAX_RESEND) { clearInterval(resendWatcher); return; }
            if (Date.now() - lastSendAt < RESEND_AFTER_MS) return;
            const btn = findSendCodeBtn();
            if (btn) {
                resendCount++;
                log(`🔄 Resend ${resendCount}/${MAX_RESEND}...`);
                await fastClick(btn);
                lastSendAt = Date.now();
                await sleep(1000);
            }
        }, RESEND_CHECK_MS);

        while (Date.now() - start < OTP_TIMEOUT_MS) {
            await sleep(rand(2000, 3000));  // poll nhanh hơn — 2-3s thay vì 5-10s
            log(`⏳ Chờ OTP... ${Math.floor((Date.now()-start)/1000)}s | Resend: ${resendCount}/${MAX_RESEND}`);
            try {
                const res = await httpRequest({
                    method: 'GET',
                    url: `https://api.internal.temp-mail.io/api/v3/email/${email}/messages`,
                    headers: { 'User-Agent': navigator.userAgent }
                });
                if (Array.isArray(res) && res.length > 0) {
                    for (const mail of [...res].reverse()) {
                        const full = `${mail.subject||''}\n${mail.body_text||''}\n${mail.body_html||''}`;
                        const otp  = extractOtp(full);
                        if (otp) { otpFound = otp; break; }
                    }
                }
            } catch (e) { console.warn('[poll]', e); }
            if (otpFound) break;
        }
        done = true;
        clearInterval(resendWatcher);
        return otpFound;
    }

    // ─── EXPORT TXT ───────────────────────────────────────────────────────────
    function exportTxt() {
        const list = loadAccounts();
        if (!list.length) { log('❌ Chưa có acc nào để xuất.'); return; }
        const lines = list.map(a => `${a.username}|${a.password}(${a.email})`).join('\r\n');
        const blob  = new Blob(['\uFEFF' + lines], { type: 'text/plain;charset=utf-8' });
        const url   = URL.createObjectURL(blob);
        const link  = document.createElement('a');
        link.href     = url;
        link.download = `garena_${Date.now()}.txt`;
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
        URL.revokeObjectURL(url);
        log(`💾 Xuất ${list.length} acc → garena_${Date.now()}.txt`);
    }

    // ─── UI ───────────────────────────────────────────────────────────────────
    const style = document.createElement('style');
    style.textContent = `
        #garena-auto-icon{position:fixed;top:80px;right:20px;width:50px;height:50px;background:linear-gradient(135deg,#ff6b00,#cc0000);border-radius:50%;display:flex;align-items:center;justify-content:center;color:#fff;font-size:22px;font-weight:bold;box-shadow:0 4px 15px rgba(0,0,0,.5);z-index:999999;cursor:pointer;user-select:none}
        #garena-auto-panel{position:fixed;top:140px;right:20px;width:340px;background:#1a1a1a;border:2px solid #ff6b00;border-radius:12px;color:#fff;font-family:system-ui,sans-serif;z-index:999998;box-shadow:0 8px 30px rgba(0,0,0,.7);display:none;flex-direction:column;max-height:88vh;overflow:hidden}
        #garena-auto-panel .hdr{padding:12px 15px;border-bottom:1px solid #333;font-size:14px;font-weight:bold;color:#ff6b00;text-align:center;flex-shrink:0}
        #garena-auto-panel .body{padding:12px 15px;overflow-y:auto;flex:1}
        .g-section{background:#111;border:1px solid #2a2a2a;border-radius:8px;padding:10px;margin-bottom:10px}
        .g-section-title{font-size:10px;color:#ff6b00;font-weight:bold;text-transform:uppercase;letter-spacing:.5px;margin-bottom:8px}
        .g-row{display:flex;align-items:center;gap:8px;margin-bottom:7px}
        .g-row:last-child{margin-bottom:0}
        .g-row label{color:#aaa;font-size:11px;white-space:nowrap;width:90px;flex-shrink:0}
        .g-row input{flex:1;background:#1a1a1a;border:1px solid #444;border-radius:5px;color:#fff;padding:5px 8px;font-size:12px}
        .g-row input:focus{outline:none;border-color:#ff6b00}
        .g-row .domain-tag{color:#888;font-size:10px;white-space:nowrap;font-family:monospace}
        .g-preview{font-size:10px;color:#666;margin-top:4px;font-family:monospace;text-align:right}
        #garena-auto-panel .status{background:#0d0d0d;border:1px solid #333;border-radius:6px;padding:8px;font-size:11px;min-height:55px;max-height:110px;overflow-y:auto;color:#00ffcc;white-space:pre-wrap;word-break:break-all;margin-bottom:8px}
        .domain-info{font-size:10px;color:#888;text-align:center;margin-bottom:4px;font-family:monospace}
        .progress{font-size:12px;color:#ff6b00;text-align:center;margin-bottom:8px;font-weight:bold}
        #garena-auto-panel button{width:100%;padding:9px;border:none;border-radius:6px;font-weight:bold;font-size:13px;cursor:pointer;margin-top:6px;color:#fff}
        #garena-start-btn{background:#28a745}
        #garena-start-btn.running{background:#dc3545}
        #garena-view-btn{background:#6f42c1}
        #garena-export-btn{background:#0d6efd}
        #garena-clear-btn{background:#2a2a2a;color:#aaa}
        .account-card{background:#111;border:1px solid #2a2a2a;border-radius:8px;padding:8px;margin-top:8px;font-size:11px}
        .account-card .row{display:flex;justify-content:space-between;margin-bottom:3px}
        .account-card .label{color:#666}
        .account-card .value{color:#00ffcc;font-family:monospace;word-break:break-all;max-width:195px;text-align:right}
    `;
    document.head.appendChild(style);

    const icon = document.createElement('div');
    icon.id = 'garena-auto-icon';
    icon.textContent = '🎮';
    document.body.appendChild(icon);

    const savedEmailPrefix = GM_getValue(CFG_EMAIL_PREFIX, 'duytoan');
    const savedUserPrefix  = GM_getValue(CFG_USER_PREFIX,  'duytoan');
    const savedPassword    = GM_getValue(CFG_PASSWORD,     '@Duytoan20009');

    const panel = document.createElement('div');
    panel.id = 'garena-auto-panel';
    panel.innerHTML = `
        <div class="hdr">🎮 Garena Auto Register v9.5 ⚡</div>
        <div class="body">
            <div class="g-section">
                <div class="g-section-title">⚙️ Cài đặt</div>
                <div class="g-row">
                    <label>🎯 Số acc:</label>
                    <input id="garena-target-count" type="number" min="1" max="500" value="5" style="max-width:70px">
                </div>
                <div class="g-row">
                    <label>📧 Prefix email:</label>
                    <input id="garena-email-prefix" type="text" value="${savedEmailPrefix}" placeholder="duytoan" maxlength="30">
                    <span class="domain-tag">+số@domain</span>
                </div>
                <div class="g-row">
                    <label>👤 Prefix tên:</label>
                    <input id="garena-user-prefix" type="text" value="${savedUserPrefix}" placeholder="duytoan" maxlength="30">
                    <span class="domain-tag">+số</span>
                </div>
                <div class="g-row">
                    <label>🔑 Mật khẩu:</label>
                    <input id="garena-password" type="text" value="${savedPassword}" placeholder="@Duytoan20009" maxlength="50">
                </div>
                <div class="g-preview" id="garena-preview">
                    email: ${savedEmailPrefix}12345@gmeenramy.com · user: ${savedUserPrefix}12345
                </div>
            </div>
            <div class="domain-info">📧 gmeenramy.com · ruutukf.com</div>
            <div class="progress" id="garena-progress">Đã tạo: 0 / 5</div>
            <div class="status" id="garena-status">Ready.</div>
            <button id="garena-start-btn">🚀 START</button>
            <button id="garena-view-btn">📋 XEM ACC</button>
            <button id="garena-export-btn">💾 XUẤT FILE TXT</button>
            <button id="garena-clear-btn">🗑 XÓA SESSION</button>
            <div id="garena-accounts"></div>
        </div>
    `;
    document.body.appendChild(panel);

    const statusBox   = document.getElementById('garena-status');
    const startBtn    = document.getElementById('garena-start-btn');
    const viewBtn     = document.getElementById('garena-view-btn');
    const exportBtn   = document.getElementById('garena-export-btn');
    const clearBtn    = document.getElementById('garena-clear-btn');
    const accountsDiv = document.getElementById('garena-accounts');
    const targetInput = document.getElementById('garena-target-count');
    const progressDiv = document.getElementById('garena-progress');
    const previewDiv  = document.getElementById('garena-preview');
    const emailPfxInp = document.getElementById('garena-email-prefix');
    const userPfxInp  = document.getElementById('garena-user-prefix');
    const passwordInp = document.getElementById('garena-password');

    function updatePreview() {
        const ep = (emailPfxInp.value || 'duytoan').trim();
        const up = (userPfxInp.value  || 'duytoan').trim();
        const d  = FIXED_DOMAINS[domainIndex % FIXED_DOMAINS.length];
        if (previewDiv) previewDiv.textContent = `email: ${ep}12345@${d} · user: ${up}12345`;
    }
    emailPfxInp.addEventListener('input', updatePreview);
    userPfxInp.addEventListener('input', updatePreview);

    function log(msg) {
        if (statusBox) { statusBox.textContent = msg; statusBox.scrollTop = statusBox.scrollHeight; }
        console.log('[Garena]', msg);
    }

    function getTarget()  { return parseInt(targetInput?.value || '5', 10) || 5; }
    function getCreated() { return GM_getValue(SESSION_COUNT_KEY, 0); }

    function updateProgress() {
        if (progressDiv) progressDiv.textContent = `Đã tạo: ${getCreated()} / ${getTarget()}`;
    }

    function updateStartBtn() {
        const running = GM_getValue(AUTO_LOOP_KEY, false) || isRunning;
        startBtn.textContent = running ? '⏹ DỪNG' : '🚀 START';
        startBtn.classList.toggle('running', running);
    }

    function escapeHtml(s) {
        return String(s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
    }

    function renderAccounts() {
        const list = loadAccounts();
        if (!list.length) {
            accountsDiv.innerHTML = '<div style="text-align:center;color:#555;padding:12px;font-size:11px;">Chưa có acc nào.</div>';
            return;
        }
        accountsDiv.innerHTML = list.slice().reverse().map((a, i) => `
            <div class="account-card">
                <div class="row"><span class="label">#${list.length - i}</span><span class="value" style="color:#ff6b00">${escapeHtml(a.createdAt?.slice(0,10)||'')}</span></div>
                <div class="row"><span class="label">Email</span><span class="value">${escapeHtml(a.email)}</span></div>
                <div class="row"><span class="label">User</span><span class="value">${escapeHtml(a.username||'—')}</span></div>
                <div class="row"><span class="label">Pass</span><span class="value">${escapeHtml(a.password||'—')}</span></div>
            </div>`).join('');
    }

    // ─── EVENTS ───────────────────────────────────────────────────────────────
    icon.addEventListener('click', () => {
        panel.style.display = panel.style.display === 'flex' ? 'none' : 'flex';
    });
    viewBtn.addEventListener('click', renderAccounts);
    exportBtn.addEventListener('click', exportTxt);
    clearBtn.addEventListener('click', () => {
        GM_setValue(SESSION_COUNT_KEY, 0);
        GM_setValue(PENDING_KEY, '');
        domainIndex = 0;
        updateProgress();
        log('🗑 Session reset.');
    });

    // ─── FORM HELPERS ─────────────────────────────────────────────────────────
    function checkEmailError() {
        for (const div of document.querySelectorAll('.error,.invalid-feedback,[class*="error"]')) {
            if (!isVisible(div)) continue;
            const t = (div.textContent || '').toLowerCase();
            if (t.includes('chưa được ủy quyền') || t.includes('không hợp lệ') || t.includes('đã tồn tại') || t.includes('không được phép')) return true;
        }
        return false;
    }

    function isSuccessPage() {
        const t = (document.body.innerText || '').toLowerCase();
        return t.includes('cám ơn vì đã tạo tài khoản garena') ||
               t.includes('cảm ơn vì đã tạo tài khoản') ||
               t.includes('chúc mừng! bạn đã đăng kí thành công');
    }

    function isBlockedPage() {
        const t = (document.body.innerText || '').toLowerCase();
        return t.includes('truy cập tạm thời bị hạn chế') || t.includes('temporarily restricted');
    }

    async function fillUsernameForm() {
        let userInput = null;
        for (const inp of document.querySelectorAll('input')) {
            if (!isVisible(inp)) continue;
            const ph = (inp.placeholder || '').toLowerCase();
            const nm = (inp.name || '').toLowerCase();
            if (ph.includes('tên truy cập') || ph.includes('username') || nm.includes('user')) { userInput = inp; break; }
        }
        const username = genUsername();
        if (userInput) await fastFill(userInput, username);
        return username;
    }

    async function fillOtpField(otp) {
        // Single-char boxes (8 ô riêng lẻ)
        const boxes = Array.from(document.querySelectorAll('input')).filter(inp => {
            if (!isVisible(inp)) return false;
            return parseInt(inp.getAttribute('maxlength') || inp.maxLength || 0, 10) === 1;
        });
        if (boxes.length >= 8) {
            for (let i = 0; i < boxes.length && i < otp.length; i++) {
                if (!document.contains(boxes[i])) return false;
                boxes[i].focus();
                nativeSetter.call(boxes[i], otp[i]);
                boxes[i].dispatchEvent(new Event('input',  { bubbles: true }));
                boxes[i].dispatchEvent(new Event('change', { bubbles: true }));
                await sleep(30);
            }
            return true;
        }
        // Single OTP input
        for (const inp of document.querySelectorAll('input')) {
            if (!isVisible(inp) || inp.type === 'password' || inp.type === 'checkbox') continue;
            const ph = (inp.placeholder || '').toLowerCase();
            const nm = (inp.name || '').toLowerCase();
            if (ph.includes('otp') || ph.includes('mã') || ph.includes('code') || nm.includes('otp') || nm.includes('code')) {
                await fastFill(inp, otp);
                return true;
            }
        }
        return false;
    }

    // ─── MAIN FLOW ────────────────────────────────────────────────────────────
    async function startRegistration() {
        if (isRunning) return;
        isRunning = true;
        updateStartBtn();

        try {
            if (getCreated() >= getTarget()) {
                log(`✅ Đã đủ ${getTarget()} acc. Dừng.`);
                GM_setValue(AUTO_LOOP_KEY, false);
                return;
            }

            const currentPass = getPassword();

            // Username
            log('✏️ Điền username...');
            const username = await fillUsernameForm();
            await sleep(100);

            // Email
            const emailInput = document.querySelector('input[type="email"], input[placeholder*="Email"]');
            if (!emailInput) throw new Error('Không tìm thấy ô email');

            const domain = FIXED_DOMAINS[domainIndex % FIXED_DOMAINS.length];
            domainIndex++;
            log(`📧 Tạo email: ${getEmailPrefix()}+số@${domain}`);

            const mailInfo = await createMailWithDomain(domain);
            if (!mailInfo) throw new Error('Tạo mail thất bại');

            log(`📧 ${mailInfo.email}`);
            await fastFill(emailInput, mailInfo.email);
            await sleep(200);

            if (checkEmailError()) {
                log('❌ Email bị lỗi — kiểm tra domain.');
                GM_setValue(AUTO_LOOP_KEY, false);
                return;
            }

            // Password
            log('🔑 Điền mật khẩu...');
            const pwdInputs = Array.from(document.querySelectorAll('input[type="password"]')).filter(isVisible);
            for (const inp of pwdInputs) {
                await fastFill(inp, currentPass);
                await sleep(50);
            }

            // Checkboxes
            for (const cb of document.querySelectorAll('input[type="checkbox"]')) {
                if (!isVisible(cb) || cb.checked) continue;
                cb.checked = true;
                cb.dispatchEvent(new Event('change', { bubbles: true }));
                await sleep(50);
            }

            // NHẬN MÃ
            log('📨 Nhấn NHẬN MÃ...');
            await sleep(200);
            const firstBtn = findSendCodeBtn();
            if (firstBtn) {
                await fastClick(firstBtn);
                await sleep(800);
            }

            // Poll OTP
            log(`📬 Chờ OTP (resend sau ${RESEND_AFTER_MS/1000}s)...`);
            const otp = await pollOtpWithResend(mailInfo.email);

            if (!otp) {
                log('❌ OTP timeout. Dừng.');
                GM_setValue(AUTO_LOOP_KEY, false);
                return;
            }

            log(`✅ OTP: ${otp} — đang điền...`);
            await sleep(200);
            const filled = await fillOtpField(otp);

            if (filled) {
                await sleep(300);
                const submitBtn =
                    document.querySelector('button.primary[type="submit"]') ||
                    Array.from(document.querySelectorAll('button')).find(b =>
                        (b.textContent.includes('Đăng Ký Ngay') || b.textContent.includes('Đăng ký ngay')) && isVisible(b));
                if (submitBtn && isVisible(submitBtn) && !submitBtn.disabled) {
                    log('📤 Submit...');
                    await fastClick(submitBtn);
                }
            }

            GM_setValue(PENDING_KEY, JSON.stringify({ email: mailInfo.email, username, password: currentPass }));
            log('⏳ Chờ trang xác nhận...');

        } catch (e) {
            console.error(e);
            log('❌ Lỗi: ' + (e.message || String(e)));
            GM_setValue(AUTO_LOOP_KEY, false);
        } finally {
            isRunning = false;
            updateStartBtn();
        }
    }

    // ─── NAV LOOP ─────────────────────────────────────────────────────────────
    async function navCheckLoop() {
        if (!GM_getValue(AUTO_LOOP_KEY, false)) return;

        if (isBlockedPage()) {
            log('🛑 BỊ CHẶN! Bật VPN / đổi 4G rồi F5.');
            GM_setValue(AUTO_LOOP_KEY, false);
            updateStartBtn();
            return;
        }

        if (isSuccessPage()) {
            const pendingRaw = GM_getValue(PENDING_KEY, '');
            if (pendingRaw) {
                try {
                    const acc      = JSON.parse(pendingRaw);
                    upsertAccount(acc);
                    const newCount = getCreated() + 1;
                    GM_setValue(SESSION_COUNT_KEY, newCount);
                    GM_setValue(PENDING_KEY, '');
                    updateProgress();
                    renderAccounts();
                    log(`🎉 Xác nhận OK! Đã tạo: ${newCount}/${getTarget()}`);

                    if (newCount >= getTarget()) {
                        log(`✅ Đủ ${getTarget()} acc! Dừng.`);
                        GM_setValue(AUTO_LOOP_KEY, false);
                        updateStartBtn();
                        return;
                    }
                } catch (e) { console.warn('[pending parse]', e); }
            }

            // Qua acc tiếp — không đợi 8-15s nữa, 500ms là đủ
            await sleep(500);
            window.location.href = 'https://sso.garena.com/universal/login?app_id=10100&redirect_uri=https%3A%2F%2Faccount.garena.com%2F%3Flocale_name%3DVN&locale=vi-VN';
            return;
        }

        if (window.location.href.includes('/login')) {
            const loginNow = Array.from(document.querySelectorAll('button')).find(b => b.textContent.includes('Đăng nhập ngay bây giờ') && isVisible(b));
            if (loginNow) { await fastClick(loginNow); return; }
            const regBtn =
                document.querySelector('button.secondary.register') ||
                Array.from(document.querySelectorAll('button')).find(b => b.textContent.includes('Tạo tài khoản mới') && isVisible(b));
            if (regBtn) { await fastClick(regBtn); return; }
        }

        if (window.location.href.includes('/register') && !isRunning) {
            if (document.querySelector('input[type="email"], input[placeholder*="Email"]')) {
                await sleep(300);
                startRegistration();
            }
        }
    }

    // ─── CONTROLS ─────────────────────────────────────────────────────────────
    startBtn.addEventListener('click', async () => {
        if (GM_getValue(AUTO_LOOP_KEY, false) || isRunning) {
            GM_setValue(AUTO_LOOP_KEY, false);
            isRunning = false;
            log('⏹ Đã dừng.');
            updateStartBtn();
        } else {
            saveConfig();
            GM_setValue(SESSION_COUNT_KEY, 0);
            GM_setValue(PENDING_KEY, '');
            domainIndex = 0;
            GM_setValue(AUTO_LOOP_KEY, true);
            updateStartBtn();
            updateProgress();
            log(`⚡ Speed mode | prefix: ${getEmailPrefix()} | pass: ${getPassword()}`);
            await sleep(200);
            navCheckLoop();
        }
    });

    function scheduleNextLoop() {
        if (navLoopTimer) clearTimeout(navLoopTimer);
        navLoopTimer = setTimeout(async () => {
            await navCheckLoop();
            scheduleNextLoop();
        }, rand(800, 1500));  // 0.8-1.5s thay vì 4-9s
    }

    // ─── INIT ─────────────────────────────────────────────────────────────────
    setTimeout(() => {
        updateStartBtn();
        updateProgress();
        updatePreview();
        if (loadAccounts().length > 0) renderAccounts();
        if (GM_getValue(AUTO_LOOP_KEY, false)) navCheckLoop();
        scheduleNextLoop();
    }, 300);  // init ngay sau 300ms

})();
