// MyPocket - Supabase 인증 + 사용자별 클라우드 저장 (비로그인 시 localStorage)
import { createClient } from '@supabase/supabase-js';
import { SUPABASE_URL, SUPABASE_ANON_KEY, isSupabaseConfigured } from './config.js';

const supabase = isSupabaseConfigured()
    ? createClient(SUPABASE_URL, SUPABASE_ANON_KEY)
    : null;

let currentUser = null;
let syncInFlight = null;
let syncQueued = false;
/** 로그인 세션에서 클라우드(또는 명시적 마이그레이션) 로드가 끝나기 전엔 동기화하지 않음 */
let cloudReady = false;
let loadDataPromise = null;

const LEGACY_CARDS_KEY = 'mypocket_cards';
const GUEST_CARDS_KEY = 'mypocket_cards__guest';

function cardsStorageKey(userId = currentUser?.id) {
    return userId ? `mypocket_cards__${userId}` : GUEST_CARDS_KEY;
}

function migrateLegacyLocalCards() {
    const legacy = localStorage.getItem(LEGACY_CARDS_KEY);
    if (legacy === null) return;
    if (localStorage.getItem(GUEST_CARDS_KEY) === null) {
        localStorage.setItem(GUEST_CARDS_KEY, legacy);
    }
    localStorage.removeItem(LEGACY_CARDS_KEY);
}

function readStoredCards(userId = currentUser?.id) {
    try {
        const raw = localStorage.getItem(cardsStorageKey(userId));
        if (raw === null) return null;
        return JSON.parse(raw);
    } catch (e) {
        console.error('❌ LocalStorage 파싱 실패:', e);
        return null;
    }
}

function writeStoredCards(cards, userId = currentUser?.id) {
    localStorage.setItem(cardsStorageKey(userId), JSON.stringify(cards));
}

function hasUserCreatedCards(cards) {
    return (cards || []).some(c => c.source === 'ai_buddy' || c.source === 'csv' || c.source === 'user');
}

// --- GLOBAL EXPOSURE (CRITICAL FOR UI) ---
window.updateCategory = (cat) => {
    if (typeof internalUpdateCategory === 'function') internalUpdateCategory(cat);
};
window.clearAllData = () => {
    if (confirm("정말로 모든 데이터를 '완전 삭제'하고 초기화하시겠습니까? 샘플 데이터도 모두 삭제됩니다.")) {
        void resetAllData();
    }
};
window.importFromCSV = (e) => {
    if (typeof internalImportFromCSV === 'function') internalImportFromCSV(e);
};
window.handleAddToPocket = () => {
    if (typeof internalHandleAddToPocket === 'function') internalHandleAddToPocket();
};

// --- STATE MANAGEMENT ---
let state = {
    allCards: [],
    currentQueue: [],
    currentIndex: 1, // Current view index in session
    sessionTotal: 0, // Total cards in current category at session start
    currentCategory: 'all',
    streak: 0,
    isGenerating: false
};

// --- Data: Preset Flashcards ---
const PRESET_CARDS = [
    { id: 't1', cat: 'travel', en: "Where is the nearest subway station?", ko: "가장 가까운 지하철역이 어디인가요?", usage: "길 찾기의 기본! 'Where is' 뒤에 장소만 바꾸면 어디든 물어볼 수 있어요.", ex: "Excuse me, where is the nearest subway station?", source: 'preset', done: false },
    { id: 't2', cat: 'travel', en: "I'd like to check in, please.", ko: "체크인하고 싶습니다.", usage: "호텔 도착 시 가장 먼저 쓰게 되는 문장입니다.", ex: "Hello, I have a reservation. I'd like to check in, please.", source: 'preset', done: false },
    { id: 'd1', cat: 'daily', en: "How are you doing today?", ko: "오늘 하루 어떠세요?", usage: "상대방의 하루를 묻는 인삿말입니다.", ex: "Hi there! How are you doing today?", source: 'preset', done: false },
    { id: 'b1', cat: 'biz', en: "I'm calling to clarify some points.", ko: "몇 가지 사항을 확인하기 위해 전화드렸습니다.", usage: "전화 비즈니스의 시작!", ex: "Hello, I'm calling to clarify some points in the contract.", source: 'preset', done: false }
];

// --- DOM Elements ---
const flashcard = document.getElementById('flashcard');
const cardEn = document.getElementById('card-en');
const cardKo = document.getElementById('card-ko');
const cardUsage = document.getElementById('card-usage');
const cardEx = document.getElementById('card-ex');
const progressFill = document.getElementById('progress-fill');
const cardCountLabel = document.getElementById('card-count');
const btnAgain = document.getElementById('btn-again');
const btnDone = document.getElementById('btn-done');
const toastContainer = document.getElementById('toast-container');
const categoryTabs = document.getElementById('category-tabs');
const bottomNavItems = document.querySelectorAll('.nav-item');
const panels = document.querySelectorAll('.panel');

const aiInputKo = document.getElementById('ai-input-ko');
const aiInputEn = document.getElementById('ai-input-en');
const aiCatBtns = document.querySelectorAll('.ai-cat-btn');
const btnAiGenerate = document.getElementById('btn-ai-generate');
const aiToneBtns = document.querySelectorAll('.ai-tone-btn');
const aiResult = document.getElementById('ai-result');
const aiResultEn = document.getElementById('ai-result-en');
const aiResultKo = document.getElementById('ai-result-ko');
const aiResultUsage = document.getElementById('ai-result-usage');
const aiResultEx = document.getElementById('ai-result-ex');
const btnAddToPocket = document.getElementById('btn-add-to-pocket');

const myCardList = document.getElementById('my-card-list');
const btnCsvExport = document.getElementById('btn-csv-export');
const csvImport = document.getElementById('csv-import');

const btnLogin = document.getElementById('btn-login');
const btnLogout = document.getElementById('btn-logout');
const authUserEl = document.getElementById('auth-user');
const authEmailEl = document.getElementById('auth-email');
const authModal = document.getElementById('auth-modal');
const authForm = document.getElementById('auth-form');
const authEmailInput = document.getElementById('auth-email-input');
const authPasswordInput = document.getElementById('auth-password-input');
const authErrorEl = document.getElementById('auth-error');
const authSubmitBtn = document.getElementById('auth-submit');
const authModalTitle = document.getElementById('auth-modal-title');
const syncNotice = document.getElementById('sync-notice');

let authMode = 'login';

// --- Initialization ---
async function init() {
    migrateLegacyLocalCards();
    setupEventListeners();
    setupAuthUI();
    await restoreSession();
    await loadData();
    internalUpdateCategory('all');
    renderMyList();
    updateAuthUI();
}

function mapRowToCard(row) {
    return {
        id: row.id,
        cat: row.cat,
        en: row.en,
        ko: row.ko,
        usage: row.usage || '',
        ex: row.ex || '',
        source: row.source || 'user',
        done: !!row.done
    };
}

function cardToRow(card) {
    return {
        id: card.id,
        user_id: currentUser.id,
        cat: card.cat,
        en: card.en,
        ko: card.ko,
        usage: card.usage || '',
        ex: card.ex || '',
        source: card.source || 'user',
        done: !!card.done
    };
}

async function restoreSession() {
    if (!supabase) {
        console.warn('⚠️ Supabase 미설정: config.js 에 URL/anon key 를 넣어주세요.');
        return;
    }
    const { data: { session } } = await supabase.auth.getSession();
    currentUser = session?.user ?? null;
    supabase.auth.onAuthStateChange(async (_event, nextSession) => {
        const prevId = currentUser?.id;
        currentUser = nextSession?.user ?? null;
        updateAuthUI();
        if (currentUser?.id && currentUser.id !== prevId) {
            await loadData();
            internalUpdateCategory(state.currentCategory);
            renderMyList();
        } else if (!currentUser && prevId) {
            cloudReady = false;
            enterGuestMode();
            internalUpdateCategory(state.currentCategory);
            renderMyList();
        }
    });
}

/** 비로그인(게스트) 데이터만 로드 — 다른 계정 캐시는 절대 읽지 않음 */
function loadLocalOnly() {
    const saved = readStoredCards(null);
    if (saved !== null) {
        state.allCards = saved;
    } else {
        state.allCards = [...PRESET_CARDS];
        writeStoredCards(state.allCards, null);
    }
}

function enterGuestMode() {
    cloudReady = false;
    loadLocalOnly();
}

async function loadData() {
    if (loadDataPromise) return loadDataPromise;
    loadDataPromise = loadDataInternal().finally(() => {
        loadDataPromise = null;
    });
    return loadDataPromise;
}

async function loadDataInternal() {
    if (!supabase || !currentUser) {
        enterGuestMode();
        const aiCards = state.allCards.filter(c => c.source === 'ai_buddy').length;
        const csvCards = state.allCards.filter(c => c.source === 'csv').length;
        console.log(`✅ Guest 로드: 총 ${state.allCards.length}개 (AI버디: ${aiCards}, CSV: ${csvCards})`);
        return;
    }

    cloudReady = false;

    try {
        const { data, error } = await supabase
            .from('cards')
            .select('id, cat, en, ko, usage, ex, source, done, created_at')
            .order('created_at', { ascending: true });

        if (error) throw error;

        if (data && data.length > 0) {
            state.allCards = data.map(mapRowToCard);
            writeStoredCards(state.allCards, currentUser.id);
            cloudReady = true;
            console.log(`☁️ Cloud 로드: ${state.allCards.length}개`);
            return;
        }

        // 클라우드가 비어 있을 때만: 게스트(비로그인) 데이터를 확인 후 가져오기
        const guestCards = readStoredCards(null);
        if (hasUserCreatedCards(guestCards)) {
            const ok = confirm(
                `이 브라우저(비로그인)에 저장된 카드 ${guestCards.length}개를\n` +
                `지금 로그인한 계정으로 가져올까요?\n\n` +
                `취소를 누르면 기본 카드로 새 계정을 시작합니다.`
            );
            if (ok) {
                state.allCards = guestCards;
                cloudReady = true;
                await syncToCloud(true);
                writeStoredCards(state.allCards, currentUser.id);
                localStorage.removeItem(GUEST_CARDS_KEY);
                showToast('브라우저 카드를 이 계정으로 가져왔습니다.');
                return;
            }
        }

        state.allCards = [...PRESET_CARDS];
        cloudReady = true;
        await syncToCloud(true);
        writeStoredCards(state.allCards, currentUser.id);
        showToast('새 계정용 기본 카드를 준비했습니다.');
    } catch (e) {
        console.error('❌ Cloud 로드 실패:', e);
        // 이 계정의 캐시만 사용. 게스트/타인 데이터로 폴백·동기화하지 않음.
        const cached = readStoredCards(currentUser.id);
        if (cached && cached.length > 0) {
            state.allCards = cached;
            cloudReady = false; // 클라우드와 불일치 가능 → 업로드 금지
            showToast('클라우드 연결 실패 — 이 계정 로컬 캐시만 표시합니다.');
        } else {
            state.allCards = [...PRESET_CARDS];
            cloudReady = false;
            showToast('클라우드 로드 실패 — 동기화는 일시 중지되었습니다.');
        }
    }
}

function saveToLocalStorage() {
    try {
        writeStoredCards(state.allCards);
        const aiCards = state.allCards.filter(c => c.source === 'ai_buddy').length;
        const csvCards = state.allCards.filter(c => c.source === 'csv').length;
        console.log(`💾 저장: 총 ${state.allCards.length}개 (AI버디: ${aiCards}, CSV: ${csvCards})`);
    } catch (e) {
        console.error('❌ LocalStorage 저장 실패:', e);
        showToast('저장 중 오류가 발생했습니다.');
    }

    if (supabase && currentUser && cloudReady) {
        void syncToCloud(false);
    }
}

async function syncToCloud(immediate = false) {
    if (!supabase || !currentUser || !cloudReady) return;

    if (syncInFlight) {
        syncQueued = true;
        if (!immediate) return;
        await syncInFlight;
    }

    const run = async () => {
        try {
            const rows = state.allCards.map(cardToRow);
            const { data: existing, error: listError } = await supabase.from('cards').select('id');
            if (listError) throw listError;

            const existingIds = new Set((existing || []).map(r => r.id));
            const localIds = new Set(rows.map(r => r.id));
            const toDelete = [...existingIds].filter(id => !localIds.has(id));

            if (toDelete.length > 0) {
                const { error: delError } = await supabase.from('cards').delete().in('id', toDelete);
                if (delError) throw delError;
            }

            if (rows.length > 0) {
                const { error: upsertError } = await supabase
                    .from('cards')
                    .upsert(rows, { onConflict: 'user_id,id' });
                if (upsertError) throw upsertError;
            }

            writeStoredCards(state.allCards, currentUser.id);
            console.log(`☁️ Cloud 동기화 완료: ${rows.length}개`);
        } catch (e) {
            console.error('❌ Cloud 동기화 실패:', e);
            showToast('클라우드 동기화에 실패했습니다.');
        }
    };

    syncInFlight = run();
    await syncInFlight;
    syncInFlight = null;

    if (syncQueued) {
        syncQueued = false;
        await syncToCloud(true);
    }
}

async function resetAllData() {
    state.allCards = [...PRESET_CARDS];
    writeStoredCards(state.allCards);

    if (supabase && currentUser) {
        try {
            cloudReady = true;
            const { error } = await supabase.from('cards').delete().eq('user_id', currentUser.id);
            if (error) throw error;
            await syncToCloud(true);
        } catch (e) {
            console.error('❌ Cloud 초기화 실패:', e);
            showToast('클라우드 초기화에 실패했습니다.');
        }
    }

    location.reload();
}

function updateAuthUI() {
    const configured = !!supabase;
    if (btnLogin) btnLogin.classList.toggle('hidden', !configured ? false : !!currentUser);
    if (authUserEl) authUserEl.classList.toggle('hidden', !currentUser);
    if (authEmailEl) authEmailEl.textContent = currentUser?.email || '';
    if (!configured && btnLogin) {
        btnLogin.textContent = '설정 필요';
    } else if (btnLogin && !currentUser) {
        btnLogin.textContent = '로그인';
    }
    if (syncNotice) {
        syncNotice.textContent = currentUser
            ? `☁️ ${currentUser.email} 계정에 동기화 중`
            : '💡 로그인하면 클라우드에 동기화됩니다. 비로그인 시 이 브라우저에만 저장됩니다.';
    }
}

function setupAuthUI() {
    if (!btnLogin || !authModal) return;

    btnLogin.addEventListener('click', () => {
        if (!supabase) {
            showToast('config.js에 Supabase URL/키를 먼저 설정하세요.');
            return;
        }
        openAuthModal('login');
    });

    btnLogout?.addEventListener('click', async () => {
        if (!supabase) return;
        if (cloudReady) await syncToCloud(true);
        const { error } = await supabase.auth.signOut();
        if (error) {
            showToast('로그아웃 실패: ' + error.message);
            return;
        }
        currentUser = null;
        cloudReady = false;
        // 공유 PC: 화면/게스트 저장소에 이전 계정 카드가 남지 않도록 게스트는 기본값으로
        state.allCards = [...PRESET_CARDS];
        writeStoredCards(state.allCards, null);
        localStorage.removeItem(LEGACY_CARDS_KEY);
        updateAuthUI();
        internalUpdateCategory(state.currentCategory);
        renderMyList();
        showToast('로그아웃되었습니다. 이 화면의 카드는 초기화되었습니다.');
    });

    authModal.querySelectorAll('[data-close-auth]').forEach(el => {
        el.addEventListener('click', closeAuthModal);
    });

    authModal.querySelectorAll('.auth-tab').forEach(tab => {
        tab.addEventListener('click', () => {
            authMode = tab.dataset.authMode;
            authModal.querySelectorAll('.auth-tab').forEach(t => t.classList.remove('active'));
            tab.classList.add('active');
            authModalTitle.textContent = authMode === 'signup' ? '회원가입' : '로그인';
            authSubmitBtn.textContent = authMode === 'signup' ? '가입하기' : '로그인';
            authPasswordInput.autocomplete = authMode === 'signup' ? 'new-password' : 'current-password';
            hideAuthError();
        });
    });

    authForm?.addEventListener('submit', async (e) => {
        e.preventDefault();
        if (!supabase) return;

        const email = authEmailInput.value.trim();
        const password = authPasswordInput.value;
        hideAuthError();
        authSubmitBtn.disabled = true;
        authSubmitBtn.textContent = '처리 중...';

        try {
            if (authMode === 'signup') {
                const { data, error } = await supabase.auth.signUp({ email, password });
                if (error) throw error;
                if (data.session) {
                    currentUser = data.user;
                    closeAuthModal();
                    showToast('가입 완료! 클라우드 동기화를 시작합니다.');
                    await loadData();
                    internalUpdateCategory(state.currentCategory);
                    renderMyList();
                    updateAuthUI();
                } else {
                    closeAuthModal();
                    showToast('가입 메일 확인 후 로그인해 주세요.');
                }
            } else {
                const { data, error } = await supabase.auth.signInWithPassword({ email, password });
                if (error) throw error;
                currentUser = data.user;
                closeAuthModal();
                showToast('로그인되었습니다.');
                await loadData();
                internalUpdateCategory(state.currentCategory);
                renderMyList();
                updateAuthUI();
            }
        } catch (err) {
            showAuthError(err.message || '인증에 실패했습니다.');
        } finally {
            authSubmitBtn.disabled = false;
            authSubmitBtn.textContent = authMode === 'signup' ? '가입하기' : '로그인';
        }
    });
}

function openAuthModal(mode = 'login') {
    authMode = mode;
    authModal.classList.remove('hidden');
    authModal.setAttribute('aria-hidden', 'false');
    authModal.querySelectorAll('.auth-tab').forEach(t => {
        t.classList.toggle('active', t.dataset.authMode === mode);
    });
    authModalTitle.textContent = mode === 'signup' ? '회원가입' : '로그인';
    authSubmitBtn.textContent = mode === 'signup' ? '가입하기' : '로그인';
    hideAuthError();
    setTimeout(() => authEmailInput?.focus(), 50);
    if (window.lucide) lucide.createIcons();
}

function closeAuthModal() {
    authModal.classList.add('hidden');
    authModal.setAttribute('aria-hidden', 'true');
    authForm?.reset();
    hideAuthError();
}

function showAuthError(msg) {
    if (!authErrorEl) return;
    authErrorEl.textContent = msg;
    authErrorEl.classList.remove('hidden');
}

function hideAuthError() {
    if (!authErrorEl) return;
    authErrorEl.textContent = '';
    authErrorEl.classList.add('hidden');
}

function setupEventListeners() {
    bottomNavItems.forEach(item => {
        item.addEventListener('click', () => {
            const targetPanel = item.dataset.panel;
            bottomNavItems.forEach(nav => nav.classList.remove('active'));
            item.classList.add('active');
            panels.forEach(panel => {
                panel.classList.remove('active');
                if (panel.id === targetPanel) panel.classList.add('active');
            });
            if (targetPanel === 'list-panel') renderMyList();
            if (targetPanel === 'study-panel') internalUpdateCategory(state.currentCategory);
        });
    });

    categoryTabs.addEventListener('click', (e) => {
        if (e.target.classList.contains('tab-item')) {
            document.querySelectorAll('.tab-item').forEach(btn => btn.classList.remove('active'));
            e.target.classList.add('active');
            internalUpdateCategory(e.target.dataset.cat);
        }
    });

    flashcard.addEventListener('click', () => flashcard.classList.toggle('card-flipped'));
    btnDone.addEventListener('click', () => handleCardAction('done'));
    btnAgain.addEventListener('click', () => handleCardAction('again'));

    aiCatBtns.forEach(btn => {
        btn.addEventListener('click', () => {
            aiCatBtns.forEach(b => b.classList.remove('selected'));
            btn.classList.add('selected');
        });
    });

    aiToneBtns.forEach(btn => {
        btn.addEventListener('click', () => {
            aiToneBtns.forEach(b => b.classList.remove('selected'));
            btn.classList.add('selected');
        });
    });

    btnAiGenerate.addEventListener('click', handleAiGenerate);
    btnAddToPocket.addEventListener('click', internalHandleAddToPocket);

    btnCsvExport.addEventListener('click', exportToCSV);
    csvImport.addEventListener('change', internalImportFromCSV);

    document.getElementById('download-sample').addEventListener('click', (e) => {
        e.preventDefault();
        downloadSampleCSV();
    });

    document.getElementById('btn-reset-data').addEventListener('click', window.clearAllData);
}

// --- Study Logic ---
function internalUpdateCategory(cat) {
    const validCats = ['all', 'travel', 'daily', 'biz', 'user', 'done'];
    const inputCat = (cat || state.currentCategory || 'all').toLowerCase().trim();
    state.currentCategory = validCats.includes(inputCat) ? inputCat : 'all';
    
    let filtered = [];
    if (state.currentCategory === 'all') {
        filtered = state.allCards.filter(c => c.done !== true);
    } else if (state.currentCategory === 'done') {
        filtered = state.allCards.filter(c => c.done === true);
    } else if (state.currentCategory === 'user') {
        filtered = state.allCards.filter(c => c.source === 'ai_buddy' && c.done !== true);
    } else {
        filtered = state.allCards.filter(c => c.cat === state.currentCategory && c.done !== true);
    }

    const shuffle = (state.currentCategory !== 'done');
    state.currentQueue = shuffle ? shuffleArray([...filtered]) : [...filtered];
    
    // Reset counters for the new category session
    state.sessionTotal = state.currentQueue.length;
    state.currentIndex = (state.sessionTotal > 0) ? 1 : 0;
    
    renderCurrentCard();
}

function renderCurrentCard() {
    flashcard.classList.remove('card-flipped');
    const total = state.currentQueue.length;
    
    // Toggle Button Text based on category
    const btnDoneText = btnDone.querySelector('span');
    if (state.currentCategory === 'done') {
        btnDoneText.textContent = "다시 암기 필요";
        btnDone.classList.add('btn-relearn');
        btnDone.classList.remove('btn-primary', 'btn-secondary');
    } else {
        btnDoneText.textContent = "외웠어요";
        btnDone.classList.add('btn-primary');
        btnDone.classList.remove('btn-relearn', 'btn-secondary');
    }

    if (total === 0) {
        cardEn.textContent = "All Done! 🎉";
        cardKo.textContent = "학습할 카드가 없습니다.";
        cardUsage.textContent = "가져오기나 AI 버디로 카드를 추가해보세요.";
        cardEx.textContent = "";
        cardCountLabel.textContent = "0/0";
        progressFill.style.width = "0%";
        btnDone.disabled = true;
        btnAgain.disabled = true;
        return;
    }

    btnDone.disabled = false;
    btnAgain.disabled = false;
    const card = state.currentQueue[0];
    cardEn.textContent = card.en;
    cardKo.textContent = card.ko;
    cardUsage.innerText = card.usage || "";
    // Force double spacing for dialogue (Even if stored/sent as one line)
    let spacedEx = (card.ex || "");
    spacedEx = spacedEx.replace(/\s*([A-Z]:)/g, "\n\n$1").trim();
    cardEx.innerText = spacedEx;

    // Show 'My' badge if source is ai_buddy
    const isMy = (card.source === 'ai_buddy');
    document.getElementById('card-my-front').classList.toggle('hidden', !isMy);
    document.getElementById('card-my-back').classList.toggle('hidden', !isMy);
    cardCountLabel.textContent = `${state.currentIndex}/${state.sessionTotal}`;
    
    // Update progress bar to match the current card index out of the session total
    let progressPercent = (state.currentIndex / state.sessionTotal) * 100;
    progressFill.style.width = `${Math.min(progressPercent, 100)}%`;
}

function handleCardAction(action) {
    if (state.currentQueue.length === 0) return;
    const currentCard = state.currentQueue[0];

    if (action === 'done') {
        const masterIdx = state.allCards.findIndex(c => c.id === currentCard.id);
        if (masterIdx !== -1) {
            state.allCards[masterIdx].done = (state.currentCategory !== 'done');
            saveToLocalStorage();
        }
        state.currentQueue.shift();
    } else {
        const cardToRepeat = state.currentQueue.shift();
        state.currentQueue.push(cardToRepeat);
    }
    
    state.currentIndex++;
    if (state.sessionTotal > 0 && state.currentIndex > state.sessionTotal) {
        state.currentIndex = 1;
    }
    renderCurrentCard();
}

// --- API Key Modal (재사용 가능한 함수) ---
function showApiKeyModal(title = "🔑 Gemini API 키 등록", desc = "구글 AI Studio에서 발급받은 API 키를 붙여넣어 주세요.") {
    return new Promise(resolve => {
        const overlay = document.createElement('div');
        overlay.style.cssText = "position:fixed;top:0;left:0;width:100%;height:100%;background:rgba(0,0,0,0.85);z-index:9999;display:flex;align-items:center;justify-content:center;backdrop-filter:blur(6px);";
        const modal = document.createElement('div');
        modal.style.cssText = "background:#1e293b;padding:32px;border-radius:16px;width:90%;max-width:420px;box-shadow:0 20px 40px rgba(0,0,0,0.6);border:1px solid rgba(255,255,255,0.12);text-align:center;";
        modal.innerHTML = `
            <div style="font-size:2rem;margin-bottom:12px;">🔑</div>
            <h3 style="color:#fff;margin-bottom:10px;font-size:1.15rem;">${title}</h3>
            <p style="color:#94a3b8;font-size:0.86rem;margin-bottom:22px;line-height:1.6;">${desc}<br><a href="https://aistudio.google.com/app/apikey" target="_blank" style="color:#60a5fa;">AI Studio 바로가기 →</a></p>
            <input type="password" id="apikey-modal-input" placeholder="AIzaSy..." style="width:100%;padding:13px;border-radius:9px;border:1px solid rgba(255,255,255,0.2);background:rgba(0,0,0,0.25);color:#fff;margin-bottom:18px;box-sizing:border-box;font-size:0.95rem;">
            <div style="display:flex;gap:10px;">
                <button id="apikey-modal-cancel" style="flex:1;padding:13px;border-radius:9px;border:none;background:rgba(255,255,255,0.08);color:#cbd5e1;cursor:pointer;">취소</button>
                <button id="apikey-modal-save" style="flex:2;padding:13px;border-radius:9px;border:none;background:linear-gradient(135deg,#3b82f6,#6366f1);color:#fff;cursor:pointer;font-weight:bold;">저장하고 시작하기</button>
            </div>
        `;
        overlay.appendChild(modal);
        document.body.appendChild(overlay);
        // Auto-focus input
        setTimeout(() => document.getElementById('apikey-modal-input')?.focus(), 100);

        const save = () => {
            const val = document.getElementById('apikey-modal-input').value.trim();
            document.body.removeChild(overlay);
            if (val) { localStorage.setItem('GEMINI_API_KEY', val); resolve(val); }
            else resolve(null);
        };
        document.getElementById('apikey-modal-save').onclick = save;
        document.getElementById('apikey-modal-cancel').onclick = () => { document.body.removeChild(overlay); resolve(null); };
        document.getElementById('apikey-modal-input').onkeydown = (e) => { if (e.key === 'Enter') save(); };
    });
}

// 키 변경 버튼 핸들러 (내 목록 탭에서 호출)
window.changeApiKey = async () => {
    const newKey = await showApiKeyModal("🔑 API 키 변경", "새로운 Gemini API 키를 입력하면 기존 키를 교체합니다.");
    if (newKey) showToast("✅ API 키가 성공적으로 저장되었습니다!");
};

// --- AI Buddy Logic ---
async function handleAiGenerate() {
    const inputKo = aiInputKo.value.trim();
    const inputEn = aiInputEn.value.trim();
    
    // 키가 없을 때만 모달 표시 (저장된 키는 계속 재사용)
    let apiKey = localStorage.getItem('GEMINI_API_KEY');
    if (!apiKey) {
        apiKey = await showApiKeyModal();
        if (!apiKey) { showToast("영작하려면 API 키가 필요합니다."); return; }
    }
    
    if (!inputKo) { showToast("한국어 의도를 먼저 입력해주세요!"); return; }

    const catBtn = document.querySelector('.ai-cat-btn.selected');
    const toneBtn = document.querySelector('.ai-tone-btn.selected');
    const cat = catBtn ? catBtn.dataset.cat : 'biz';
    const tone = toneBtn ? toneBtn.dataset.tone : 'biz';

    btnAiGenerate.disabled = true;
    btnAiGenerate.innerHTML = '<i data-lucide="loader-2" class="spin"></i> AI 멘토가 생각 중...';
    if (window.lucide) lucide.createIcons();

    const prompt = `
        대상 카테고리: ${cat}
        선택된 톤 가이드라인:
        - official: 공식적/업무 (회사나 공적인 곳에서 격식을 갖춘 정중한 표현)
        - general: 일반 (보통의 상황에서 사람들이 보편적으로 쓰는 표준 표현)
        - casual: 캐주얼 (친구, 동료들에게 편하게 하는 일상적인 패턴)
        
        선택된 톤: ${tone}
        사용자 한국어 의도: "${inputKo}"
        사용자 초기 영작 시도: "${inputEn || '없음'}"

        역할: 넌 사용자의 영어 영작 멘토야. 
        조건:
        1. 사용자가 '초기 영작 시도'를 했다면, 그 의도를 존중하되 선택된 '톤 가이드라인'에 맞춰 더 세련된 표현으로 교정해줘.
        2. '초기 영작 시도'가 없다면, '톤 가이드라인'을 완벽히 반영하여 해당 상황에 가장 적절한 문장을 추천해줘.
        3. 'usage' 필드에는 이 문장이 선택된 톤(공식/일반/캐주얼)에 왜 적합한지, 그리고 실제 상황에서 어떤 뉘앙스로 전달되는지 친절하게 설명해줘 (한국어로).
        4. 'ex' 필드에는 이 문장을 활용한 실제 대화문 예시를 1개 적어줘. (A: ..., B: ... 형식으로 작성하고, 화자가 바뀌면 반드시 **두 줄의 줄바꿈(/n/n)**을 넣어 가독성을 높여줘)

        반드시 아래 JSON 형식으로만 응답해:
        {
          "en": "최종 교정/추천된 영어 문장",
          "ko": "문장의 한글 뜻",
          "usage": "톤/상황/문법 조언",
          "ex": "실전 활용 예문"
        }
    `;

    try {
        // --- 1. 모델 설정 (하드코딩을 통한 안정성 확보) ---
        const PREFERRED_MODELS = [
            'models/gemini-2.5-flash',
            'models/gemini-3.1-flash-lite-preview',
            'models/gemini-2.5-pro',
            'models/gemini-3.1-pro-preview',
            'models/gemini-3-flash-preview'
        ];

        // --- 2. Generation with Model Fallback ---
        let resData = null;
        let lastError = "";
        let errorReport = [];

        for (const modelId of PREFERRED_MODELS) {
            const API_URL = `https://generativelanguage.googleapis.com/v1beta/${modelId}:generateContent?key=${apiKey}`;
            
            console.log(`Trying model: ${modelId}`);
            await new Promise(r => setTimeout(r, 300)); // Short delay between model attempts
            
            let genRetryCount = 0;
            const maxRetries = 1;
            
            // Nested function to handle 503 retries for CURRENT model
            const tryThisModel = async () => {
                const res = await fetch(API_URL, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] })
                });

                if (res.status === 503 && genRetryCount < maxRetries) {
                    genRetryCount++;
                    await new Promise(r => setTimeout(r, 1000));
                    return tryThisModel();
                }
                return res;
            };

            const response = await tryThisModel();

            if (response.ok) {
                resData = await response.json();
                console.log(`Success with ${modelId}`);
                break;
            } else {
                const errJson = await response.json().catch(() => ({}));
                lastError = errJson.error?.message || "Unknown error";
                errorReport.push(`${modelId.split('/').pop()}(${response.status})`);
                
                if ([404, 429, 503].includes(response.status)) {
                    console.warn(`Model ${modelId} failed with ${response.status}, skipping...`);
                    continue; 
                } else {
                    throw new Error(`API Error ${response.status}: ${lastError}`);
                }
            }
        }

        if (!resData) {
            throw new Error(`모든 가용 모델(${errorReport.join(', ')})의 한도가 초과되었습니다. 잠시 후 다시 시도해 주세요.`);
        }

        const rawText = resData.candidates[0].content.parts[0].text;
        
        // Robust JSON Extraction
        let data;
        try {
            const cleanText = rawText.replace(/```json|```/g, "").trim();
            data = JSON.parse(cleanText);
        } catch (parseErr) {
            const jsonMatch = rawText.match(/\{[\s\S]*\}/);
            if (jsonMatch) data = JSON.parse(jsonMatch[0]);
            else throw new Error("AI 응답 데이터 분석에 실패했습니다.");
        }

        aiResultEn.textContent = data.en;
        aiResultKo.textContent = data.ko;
        aiResultUsage.textContent = data.usage;
        // Force double spacing for dialogue (Even if AI sent it in one line)
        // This splits "A: ... B: ..." into separate lines with a gap
        let spacedEx = (data.ex || "");
        // If it starts with A: but has B: later without a newline, force it
        spacedEx = spacedEx.replace(/\s*([A-Z]:)/g, "\n\n$1").trim();
        aiResultEx.innerText = spacedEx;
        
        aiResult.classList.remove('hidden');
        btnAddToPocket.disabled = false;
        btnAddToPocket.textContent = "학습 포켓에 넣기";
    } catch (e) {
        console.error("AI Buddy Detailed Error:", e);
        
        const errMsg = e.message || "";
        if (errMsg.includes("400") || errMsg.includes("API_KEY_INVALID")) {
            localStorage.removeItem('GEMINI_API_KEY');
            showToast("API 키가 올바르지 않습니다. 새 키를 입력해 주세요.");
            // 자동으로 키 입력 모달 재표시
            setTimeout(() => showApiKeyModal("🔑 API 키 재등록", "입력하신 키가 유효하지 않습니다.<br>구글 AI Studio에서 새 키를 발급받아 입력해 주세요."), 500);
        } else if (errMsg.includes("429")) {
            showToast("[한도 초과] 구글 AI가 잠시 바쁩니다. 약 30초 뒤에 다시 시도해 주세요.");
        } else {
            showToast(`에러: ${errMsg.substring(0, 80)}... (잠시 후 다시 시도해 주세요)`);
        }
        
    } finally {
        btnAiGenerate.disabled = false;
        btnAiGenerate.innerHTML = '<i data-lucide="wand-2"></i> 영작하기';
        if (window.lucide) lucide.createIcons();
    }
}

function internalHandleAddToPocket() {
    const newCard = {
        id: 'user_' + Date.now(),
        cat: document.querySelector('.ai-cat-btn.selected').dataset.cat,
        en: aiResultEn.textContent,
        ko: aiResultKo.textContent,
        usage: aiResultUsage.textContent,
        ex: aiResultEx.textContent,
        source: 'ai_buddy',
        done: false
    };
    state.allCards.push(newCard);
    saveToLocalStorage();
    showToast("포켓에 저장되었습니다!");

    // Clear UI for next phrase
    aiInputKo.value = "";
    aiInputEn.value = "";
    aiResult.classList.add('hidden');
    window.scrollTo({ top: 0, behavior: 'smooth' }); // Scroll back to top for focus
}

// --- CSV Logic ---
function exportToCSV() {
    // Helper to escape CSV fields (removes newlines and escapes quotes)
    const esc = (text) => {
        if (text === null || text === undefined) return "";
        const clean = text.toString().replace(/[\r\n]+/g, " ");
        return `"${clean.replace(/"/g, '""')}"`;
    };

    // Header with intuitive names
    let csvContent = "Category,English,Korean,Usage,Example,Origin\n";
    
    // Safety check: ensure we export the latest state
    const cardsToExport = [...state.allCards];
    
    cardsToExport.forEach(c => {
        // Map source code to human-readable labels for Excel users
        let originLabel = "Sample (기본)";
        if (c.source === 'ai_buddy') originLabel = "AI_Mentor (AI버디)";
        if (c.source === 'csv') originLabel = "My_Library (직접추가)";

        csvContent += `${esc(c.cat)},${esc(c.en)},${esc(c.ko)},${esc(c.usage)},${esc(c.ex)},${esc(originLabel)}\n`;
    });
    
    // Convert to Data URI instead of Blob to strictly enforce filename
    const uri = "data:text/csv;charset=utf-8,\ufeff" + encodeURIComponent(csvContent);
    const link = document.createElement("a");
    link.href = uri;
    // Safer filename: MyPocket_Data_YYYYMMDD.csv
    const now = new Date();
    const dateStr = now.getFullYear() + 
                    String(now.getMonth() + 1).padStart(2, '0') + 
                    String(now.getDate()).padStart(2, '0');
    link.setAttribute("download", `MyPocket_Data_${dateStr}.csv`);
    
    // Append -> Click -> Remove
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    
    showToast(`${cardsToExport.length}개의 데이터가 내보내졌습니다.`);
}

function internalImportFromCSV(e) {
    const file = e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (event) => {
        const lines = event.target.result.split('\n');
        let importCount = 0;
        lines.forEach((line, i) => {
            if (i === 0) return; // Skip header
            if (!line.trim()) return;

            // Robust split handling quoted commas
            const parts = line.split(/,(?=(?:(?:[^"]*"){2})*[^"]*$)/);
            if (parts.length >= 3) {
                const rawOrigin = (parts[5] || '').replace(/^"|"$/g, '').trim();
                let source = 'csv';
                if (rawOrigin.includes('AI_Mentor')) source = 'ai_buddy';

                state.allCards.push({
                    id: 'imp_' + Date.now() + i,
                    cat: (parts[0] || 'user').replace(/^"|"$/g, '').trim().toLowerCase(),
                    en: parts[1].replace(/^"|"$/g, '').trim(),
                    ko: parts[2].replace(/^"|"$/g, '').trim(),
                    usage: (parts[3] || '').replace(/^"|"$/g, '').trim(),
                    ex: (parts[4] || '').replace(/^"|"$/g, '').trim(),
                    source: source,
                    done: false
                });
                importCount++;
            }
        });
        saveToLocalStorage();
        renderCards();
        showToast(`${importCount}개의 문장을 가져왔습니다.`);
        
        // AUTO-SWITCH TO STUDY
        bottomNavItems.forEach(n => n.classList.remove('active'));
        document.querySelector('[data-panel="study-panel"]').classList.add('active');
        panels.forEach(p => p.classList.remove('active'));
        document.getElementById('study-panel').classList.add('active');
        
        internalUpdateCategory('all');
        showToast("가져오기 완료! 바로 학습을 시작합니다.");
        e.target.value = ''; // Reset file input
    };
    reader.readAsText(file);
}

function downloadSampleCSV() {
    const headers = "Category,English,Korean,Usage,Example,Origin\n";
    const sampleRows = "daily,Hello,안녕하세요,일반적인 인사말,A: Hello!\nB: Hi there!,Sample (기본)\nbiz,Thank you for the update,업데이트 해주셔서 감사합니다,회의나 이메일 마무리,A: Thank you for the update.\nB: You're welcome!,Sample (기본)";
    const uri = "data:text/csv;charset=utf-8,\ufeff" + encodeURIComponent(headers + sampleRows);
    const link = document.createElement("a");
    link.href = uri;
    link.setAttribute("download", "mypocket_sample_format.csv");
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
}

// --- Utils ---
function shuffleArray(array) {
    for (let i = array.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [array[i], array[j]] = [array[j], array[i]];
    }
    return array;
}

function showToast(msg) {
    const toast = document.createElement('div');
    toast.className = 'toast';
    toast.textContent = msg;
    toastContainer.appendChild(toast);
    setTimeout(() => toast.remove(), 2500);
}

window.clearAllData = function() {
    if (confirm("모든 학습 데이터와 AI 보관함이 초기화됩니다. 계속하시겠습니까?")) {
        void resetAllData();
    }
};

// --- List Logic ---
function renderMyList() {
    if (!myCardList) return;
    myCardList.innerHTML = '';
    const myCards = state.allCards.filter(c => c.source === 'ai_buddy');
    
    if (myCards.length === 0) {
        myCardList.innerHTML = '<div style="text-align:center; padding: 40px; color: rgba(255,255,255,0.4);">아직 저장된 영작이 없습니다.</div>';
        return;
    }

    myCards.forEach(card => {
        const item = document.createElement('div');
        item.className = 'list-item';
        item.innerHTML = `
            <div class="list-item-content">
                <div class="list-en">${card.en}</div>
                <div class="list-ko">${card.ko}</div>
            </div>
            <button class="btn-delete" onclick="deleteCard('${card.id}')">
                <i data-lucide="trash-2" style="width: 16px;"></i>
            </button>
        `;
        myCardList.appendChild(item);
    });
    if (window.lucide) lucide.createIcons();
}

window.deleteCard = function(id) {
    if (confirm("이 문장을 삭제할까요?")) {
        state.allCards = state.allCards.filter(c => c.id !== id);
        saveToLocalStorage();
        renderMyList();
        renderCards();
        showToast("삭제되었습니다.");
    }
};

init();
