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
    isGenerating: false,
    studyMode: 'normal', // normal | review
    coach: {
        situation: '',
        cat: 'travel',
        turns: [],
        suggest: null
    },
    dictation: {
        card: null,
        revealed: false
    }
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
const btnSpeak = document.getElementById('btn-speak');
const btnSpeakEn = document.getElementById('btn-speak-en');
const btnSpeakEx = document.getElementById('btn-speak-ex');
const btnSpeakAi = document.getElementById('btn-speak-ai');
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
    refreshReviewSummary();
    if (window.lucide) lucide.createIcons();
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
            if (targetPanel === 'study-panel') state.studyMode = 'normal';
            switchToPanel(targetPanel);
        });
    });

    categoryTabs.addEventListener('click', (e) => {
        if (e.target.classList.contains('tab-item')) {
            document.querySelectorAll('#category-tabs .tab-item').forEach(btn => btn.classList.remove('active'));
            e.target.classList.add('active');
            state.studyMode = 'normal';
            internalUpdateCategory(e.target.dataset.cat);
        }
    });

    flashcard.addEventListener('click', () => flashcard.classList.toggle('card-flipped'));
    btnDone.addEventListener('click', () => handleCardAction('done'));
    btnAgain.addEventListener('click', () => handleCardAction('again'));

    btnSpeak?.addEventListener('click', () => speakCurrentCardEnglish());
    btnSpeakEn?.addEventListener('click', (e) => {
        e.stopPropagation();
        speakCurrentCardEnglish();
    });
    btnSpeakEx?.addEventListener('click', (e) => {
        e.stopPropagation();
        const text = (cardEx?.innerText || '').trim();
        if (!text) {
            showToast('읽을 예문이 없습니다.');
            return;
        }
        speakEnglish(text);
    });
    btnSpeakAi?.addEventListener('click', () => {
        const text = (aiResultEn?.textContent || '').trim();
        if (!text || text === '...') {
            showToast('먼저 영작을 생성해 주세요.');
            return;
        }
        speakEnglish(text);
    });

    if (window.speechSynthesis) {
        window.speechSynthesis.getVoices();
        window.speechSynthesis.onvoiceschanged = () => {
            window.speechSynthesis.getVoices();
        };
    }

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

    // AI sub-tabs + coach/correct
    document.querySelectorAll('#ai-sub-tabs .sub-tab').forEach(btn => {
        btn.addEventListener('click', () => switchAiTab(btn.dataset.aiTab));
    });
    document.querySelectorAll('.coach-cat-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            document.querySelectorAll('.coach-cat-btn').forEach(b => b.classList.remove('selected'));
            btn.classList.add('selected');
        });
    });
    document.querySelectorAll('.correct-tone-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            document.querySelectorAll('.correct-tone-btn').forEach(b => b.classList.remove('selected'));
            btn.classList.add('selected');
        });
    });
    document.getElementById('btn-coach-start')?.addEventListener('click', () => void startCoachSession());
    document.getElementById('btn-coach-send')?.addEventListener('click', () => void sendCoachReply(false));
    document.getElementById('btn-coach-hint')?.addEventListener('click', () => void sendCoachReply(true));
    document.getElementById('btn-coach-reset')?.addEventListener('click', resetCoach);
    document.getElementById('btn-coach-save')?.addEventListener('click', () => {
        const s = state.coach.suggest;
        if (!s?.en) return;
        addCardToPocket({
            cat: state.coach.cat || 'daily',
            en: s.en,
            ko: s.ko || '',
            usage: s.tip || '대화 코치 추천 표현',
            ex: ''
        });
        showToast('포켓에 저장되었습니다!');
    });
    document.getElementById('btn-correct')?.addEventListener('click', () => void runCorrection());
    document.getElementById('btn-speak-correct')?.addEventListener('click', () => {
        speakEnglish(document.getElementById('correct-result-en')?.textContent || '');
    });
    document.getElementById('btn-correct-save')?.addEventListener('click', () => {
        const en = document.getElementById('correct-result-en')?.textContent?.trim();
        if (!en) return;
        addCardToPocket({
            cat: 'daily',
            en,
            ko: document.getElementById('correct-result-ko')?.textContent || '',
            usage: document.getElementById('correct-result-feedback')?.textContent || '',
            ex: document.getElementById('correct-result-ex')?.innerText || ''
        });
        showToast('포켓에 저장되었습니다!');
    });

    // Practice
    document.querySelectorAll('#practice-sub-tabs .sub-tab').forEach(btn => {
        btn.addEventListener('click', () => switchPracticeTab(btn.dataset.practiceTab));
    });
    document.getElementById('btn-review-start')?.addEventListener('click', startReviewSession);
    document.getElementById('btn-dictation-start')?.addEventListener('click', () => startDictation());
    document.getElementById('btn-dictation-replay')?.addEventListener('click', () => replayDictation(false));
    document.getElementById('btn-dictation-slow')?.addEventListener('click', () => replayDictation(true));
    document.getElementById('btn-dictation-check')?.addEventListener('click', checkDictation);
    document.getElementById('btn-dictation-next')?.addEventListener('click', () => startDictation());

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
    if (state.studyMode === 'review') {
        btnDoneText.textContent = '기억남';
        btnDone.classList.add('btn-primary');
        btnDone.classList.remove('btn-relearn', 'btn-secondary');
    } else if (state.currentCategory === 'done') {
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
        if (btnSpeak) btnSpeak.disabled = true;
        if (btnSpeakEn) btnSpeakEn.disabled = true;
        if (btnSpeakEx) btnSpeakEx.disabled = true;
        stopSpeaking();
        return;
    }

    btnDone.disabled = false;
    btnAgain.disabled = false;
    if (btnSpeak) btnSpeak.disabled = false;
    if (btnSpeakEn) btnSpeakEn.disabled = false;
    if (btnSpeakEx) btnSpeakEx.disabled = false;
    stopSpeaking();
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

function getEnglishVoice() {
    if (!window.speechSynthesis) return null;
    const voices = window.speechSynthesis.getVoices();
    return (
        voices.find(v => /en-US/i.test(v.lang) && /google|natural|premium|enhanced/i.test(v.name)) ||
        voices.find(v => /en-US/i.test(v.lang)) ||
        voices.find(v => /^en(-|$)/i.test(v.lang)) ||
        null
    );
}

function setSpeakingUi(active) {
    [btnSpeak, btnSpeakEn, btnSpeakEx, btnSpeakAi].forEach(btn => {
        if (btn) btn.classList.toggle('speaking', active);
    });
}

function stopSpeaking() {
    if (window.speechSynthesis) window.speechSynthesis.cancel();
    setSpeakingUi(false);
}

function speakEnglish(text, rate = 0.92) {
    const clean = (text || '').replace(/\s+/g, ' ').trim();
    if (!clean) {
        showToast('읽을 영어 문장이 없습니다.');
        return;
    }
    if (!window.speechSynthesis) {
        showToast('이 브라우저는 음성 읽기를 지원하지 않습니다.');
        return;
    }

    stopSpeaking();
    const utter = new SpeechSynthesisUtterance(clean);
    utter.lang = 'en-US';
    utter.rate = rate;
    utter.pitch = 1;
    const voice = getEnglishVoice();
    if (voice) utter.voice = voice;

    utter.onstart = () => setSpeakingUi(true);
    utter.onend = () => setSpeakingUi(false);
    utter.onerror = () => {
        setSpeakingUi(false);
        showToast('음성 재생에 실패했습니다.');
    };

    if (!voice && window.speechSynthesis.getVoices().length === 0) {
        window.speechSynthesis.getVoices();
        setTimeout(() => {
            const delayed = getEnglishVoice();
            if (delayed) utter.voice = delayed;
            window.speechSynthesis.speak(utter);
        }, 120);
        return;
    }

    window.speechSynthesis.speak(utter);
}

function speakCurrentCardEnglish() {
    if (state.currentQueue.length === 0) {
        showToast('읽을 카드가 없습니다.');
        return;
    }
    speakEnglish(state.currentQueue[0].en);
}

function handleCardAction(action) {
    if (state.currentQueue.length === 0) return;
    const currentCard = state.currentQueue[0];

    if (action === 'done') {
        const masterIdx = state.allCards.findIndex(c => c.id === currentCard.id);
        if (masterIdx !== -1) {
            if (state.studyMode === 'review') {
                scheduleSrs(currentCard.id, 3);
            } else {
                state.allCards[masterIdx].done = (state.currentCategory !== 'done');
                saveToLocalStorage();
            }
        } else if (state.studyMode === 'review') {
            scheduleSrs(currentCard.id, 3);
        }
        state.currentQueue.shift();
    } else {
        if (state.studyMode === 'review') {
            scheduleSrs(currentCard.id, 1);
        }
        const cardToRepeat = state.currentQueue.shift();
        state.currentQueue.push(cardToRepeat);
    }
    
    state.currentIndex++;
    if (state.sessionTotal > 0 && state.currentIndex > state.sessionTotal) {
        state.currentIndex = 1;
    }

    if (state.studyMode === 'review' && state.currentQueue.length === 0) {
        state.studyMode = 'normal';
        refreshReviewSummary();
        showToast('복습 세션 완료! 수고했어요.');
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

// --- Gemini shared helper ---
async function ensureGeminiApiKey() {
    let apiKey = localStorage.getItem('GEMINI_API_KEY');
    if (!apiKey) {
        apiKey = await showApiKeyModal();
    }
    return apiKey;
}

function parseGeminiJson(rawText) {
    const cleanText = rawText.replace(/```json|```/g, '').trim();
    try {
        return JSON.parse(cleanText);
    } catch (_) {
        const jsonMatch = rawText.match(/\{[\s\S]*\}/);
        if (jsonMatch) return JSON.parse(jsonMatch[0]);
        throw new Error('AI 응답 데이터 분석에 실패했습니다.');
    }
}

async function callGeminiJson(prompt) {
    const apiKey = await ensureGeminiApiKey();
    if (!apiKey) throw new Error('API_KEY_REQUIRED');

    const PREFERRED_MODELS = [
        'models/gemini-2.5-flash',
        'models/gemini-3.1-flash-lite-preview',
        'models/gemini-2.5-pro',
        'models/gemini-3.1-flash-preview',
        'models/gemini-3-flash-preview'
    ];

    let resData = null;
    let lastError = '';
    const errorReport = [];

    for (const modelId of PREFERRED_MODELS) {
        const API_URL = `https://generativelanguage.googleapis.com/v1beta/${modelId}:generateContent?key=${apiKey}`;
        await new Promise(r => setTimeout(r, 250));

        let genRetryCount = 0;
        const tryThisModel = async () => {
            const res = await fetch(API_URL, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] })
            });
            if (res.status === 503 && genRetryCount < 1) {
                genRetryCount++;
                await new Promise(r => setTimeout(r, 1000));
                return tryThisModel();
            }
            return res;
        };

        const response = await tryThisModel();
        if (response.ok) {
            resData = await response.json();
            break;
        }
        const errJson = await response.json().catch(() => ({}));
        lastError = errJson.error?.message || 'Unknown error';
        errorReport.push(`${modelId.split('/').pop()}(${response.status})`);
        if ([404, 429, 503].includes(response.status)) continue;
        throw new Error(`API Error ${response.status}: ${lastError}`);
    }

    if (!resData) {
        throw new Error(`모든 가용 모델(${errorReport.join(', ')})의 한도가 초과되었습니다. 잠시 후 다시 시도해 주세요.`);
    }

    const rawText = resData.candidates?.[0]?.content?.parts?.[0]?.text || '';
    return parseGeminiJson(rawText);
}

function handleGeminiError(e, fallbackMsg) {
    const errMsg = e?.message || '';
    if (errMsg === 'API_KEY_REQUIRED') {
        showToast('AI 기능을 쓰려면 API 키가 필요합니다.');
        return;
    }
    if (errMsg.includes('400') || errMsg.includes('API_KEY_INVALID')) {
        localStorage.removeItem('GEMINI_API_KEY');
        showToast('API 키가 올바르지 않습니다. 새 키를 입력해 주세요.');
        setTimeout(() => showApiKeyModal('🔑 API 키 재등록', '입력하신 키가 유효하지 않습니다.<br>구글 AI Studio에서 새 키를 발급받아 입력해 주세요.'), 500);
        return;
    }
    if (errMsg.includes('429')) {
        showToast('[한도 초과] 구글 AI가 잠시 바쁩니다. 약 30초 뒤에 다시 시도해 주세요.');
        return;
    }
    showToast((fallbackMsg || '에러') + ': ' + errMsg.substring(0, 80));
}

function addCardToPocket(partial) {
    const newCard = {
        id: 'user_' + Date.now() + '_' + Math.floor(Math.random() * 1000),
        cat: partial.cat || 'daily',
        en: partial.en,
        ko: partial.ko || '',
        usage: partial.usage || '',
        ex: partial.ex || '',
        source: 'ai_buddy',
        done: false
    };
    state.allCards.push(newCard);
    saveToLocalStorage();
    return newCard;
}

// --- SRS (local, per account/guest) ---
function srsStorageKey() {
    return currentUser?.id ? `mypocket_srs__${currentUser.id}` : 'mypocket_srs__guest';
}

function loadSrsMap() {
    try {
        return JSON.parse(localStorage.getItem(srsStorageKey()) || '{}');
    } catch (_) {
        return {};
    }
}

function saveSrsMap(map) {
    localStorage.setItem(srsStorageKey(), JSON.stringify(map));
}

function getSrsEntry(cardId, map = loadSrsMap()) {
    return map[cardId] || { due: 0, interval: 0, ease: 2.5, reps: 0, lapses: 0 };
}

function scheduleSrs(cardId, quality) {
    // quality: 0 fail, 1 hard/again, 3 good (외웠어요)
    const map = loadSrsMap();
    const s = getSrsEntry(cardId, map);
    const now = Date.now();
    if (quality <= 1) {
        s.lapses = (s.lapses || 0) + 1;
        s.reps = 0;
        s.interval = 0;
        s.due = now + 10 * 60 * 1000; // 10분 후
        s.ease = Math.max(1.3, (s.ease || 2.5) - 0.2);
    } else {
        s.reps = (s.reps || 0) + 1;
        if (s.reps === 1) s.interval = 1;
        else if (s.reps === 2) s.interval = 3;
        else s.interval = Math.round((s.interval || 1) * (s.ease || 2.5));
        s.ease = Math.min(3.0, (s.ease || 2.5) + 0.05);
        s.due = now + s.interval * 24 * 60 * 60 * 1000;
    }
    s.last = now;
    map[cardId] = s;
    saveSrsMap(map);
    return s;
}

function getReviewCandidates(limit = 8) {
    const now = Date.now();
    const map = loadSrsMap();
    const pool = state.allCards.filter(c => c.done !== true);
    const scored = pool.map(c => {
        const s = getSrsEntry(c.id, map);
        const overdue = (s.due || 0) <= now;
        const never = !s.reps;
        const priority = never ? 0 : (overdue ? 1 : 2);
        const dueScore = s.due || 0;
        const lapseBoost = (s.lapses || 0) * 1e11;
        return { card: c, s, priority, sortKey: priority * 1e15 + dueScore - lapseBoost };
    });
    scored.sort((a, b) => a.sortKey - b.sortKey);
    const dueOrNew = scored.filter(x => x.priority <= 1);
    const picked = (dueOrNew.length >= limit ? dueOrNew : scored).slice(0, limit);
    return picked.map(x => x.card);
}

function refreshReviewSummary() {
    const el = document.getElementById('review-summary');
    if (!el) return;
    const map = loadSrsMap();
    const now = Date.now();
    const active = state.allCards.filter(c => c.done !== true);
    let due = 0;
    let fresh = 0;
    active.forEach(c => {
        const s = getSrsEntry(c.id, map);
        if (!s.reps) fresh++;
        else if ((s.due || 0) <= now) due++;
    });
    el.textContent = `복습 대기 ${due}장 · 아직 스케줄 없는 카드 ${fresh}장 · 전체 학습 중 ${active.length}장`;
}

function startReviewSession() {
    const count = Number(document.getElementById('review-count')?.value || 8);
    const cards = getReviewCandidates(count);
    if (!cards.length) {
        showToast('복습할 카드가 없습니다. 학습 탭에서 카드를 먼저 추가해 보세요.');
        return;
    }
    state.studyMode = 'review';
    state.currentQueue = shuffleArray([...cards]);
    state.sessionTotal = state.currentQueue.length;
    state.currentIndex = 1;
    switchToPanel('study-panel');
    showToast(`복습 세션 ${state.sessionTotal}장 시작!`);
    renderCurrentCard();
}

function switchToPanel(panelId) {
    bottomNavItems.forEach(nav => {
        nav.classList.toggle('active', nav.dataset.panel === panelId);
    });
    panels.forEach(panel => {
        panel.classList.toggle('active', panel.id === panelId);
    });
    if (panelId === 'list-panel') renderMyList();
    if (panelId === 'practice-panel') refreshReviewSummary();
    if (panelId === 'study-panel' && state.studyMode === 'normal') {
        internalUpdateCategory(state.currentCategory);
    }
    if (window.lucide) lucide.createIcons();
}

function switchAiTab(tab) {
    document.querySelectorAll('#ai-sub-tabs .sub-tab').forEach(btn => {
        btn.classList.toggle('active', btn.dataset.aiTab === tab);
    });
    document.getElementById('ai-tab-write')?.classList.toggle('hidden', tab !== 'write');
    document.getElementById('ai-tab-coach')?.classList.toggle('hidden', tab !== 'coach');
    document.getElementById('ai-tab-correct')?.classList.toggle('hidden', tab !== 'correct');
    const desc = document.getElementById('ai-header-desc');
    if (desc) {
        desc.textContent =
            tab === 'coach' ? '상황을 정하면 AI가 상대역이 되어 영어로 대화합니다.' :
            tab === 'correct' ? '내가 쓴 영어를 더 자연스럽게 고쳐 줍니다.' :
            '한국어 의도를 영어 표현으로 만들어 포켓에 넣어요.';
    }
}

function switchPracticeTab(tab) {
    document.querySelectorAll('#practice-sub-tabs .sub-tab').forEach(btn => {
        btn.classList.toggle('active', btn.dataset.practiceTab === tab);
    });
    document.getElementById('practice-tab-review')?.classList.toggle('hidden', tab !== 'review');
    document.getElementById('practice-tab-dictation')?.classList.toggle('hidden', tab !== 'dictation');
    if (tab === 'review') refreshReviewSummary();
}

function renderCoachChat() {
    const box = document.getElementById('coach-chat');
    if (!box) return;
    box.innerHTML = '';
    state.coach.turns.forEach(t => {
        const div = document.createElement('div');
        div.className = `coach-bubble ${t.role}`;
        const prefix = t.role === 'npc' ? '상대' : t.role === 'user' ? '나' : '코치';
        div.textContent = `${prefix}: ${t.text}`;
        box.appendChild(div);
    });
    box.classList.remove('hidden');
    box.scrollTop = box.scrollHeight;
}

function showCoachSuggest(suggest) {
    state.coach.suggest = suggest;
    const wrap = document.getElementById('coach-suggest');
    if (!wrap || !suggest) return;
    document.getElementById('coach-suggest-en').textContent = suggest.en || '';
    document.getElementById('coach-suggest-ko').textContent = suggest.ko || '';
    document.getElementById('coach-suggest-tip').textContent = suggest.tip || '';
    wrap.classList.remove('hidden');
}

async function startCoachSession() {
    const situation = document.getElementById('coach-situation')?.value.trim();
    if (!situation) {
        showToast('상황을 먼저 입력해 주세요.');
        return;
    }
    const catBtn = document.querySelector('.coach-cat-btn.selected');
    const cat = catBtn?.dataset.cat || 'travel';
    const btn = document.getElementById('btn-coach-start');
    btn.disabled = true;
    btn.innerHTML = '<i data-lucide="loader-2" class="spin"></i> 시작 중...';
    if (window.lucide) lucide.createIcons();

    try {
        const data = await callGeminiJson(`
당신은 영어 회화 상황 코치입니다.
상황: "${situation}"
카테고리: ${cat}
역할: 현지인/상대역(NPC)으로 영어 대화를 시작하세요.
사용자가 영어로 답하면 이어서 대화합니다.

반드시 JSON만 응답:
{
  "npc": "상대의 첫 영어 대사 (1-2문장)",
  "coach_tip": "한국어로 짧게 상황 힌트",
  "suggest": { "en": "이 상황에서 유용한 영어 한 문장", "ko": "뜻", "tip": "왜 유용한지" }
}
`);
        state.coach = { situation, cat, turns: [], suggest: null };
        state.coach.turns.push({ role: 'npc', text: data.npc });
        if (data.coach_tip) state.coach.turns.push({ role: 'coach', text: data.coach_tip });
        renderCoachChat();
        document.getElementById('coach-reply-box')?.classList.remove('hidden');
        if (data.suggest?.en) showCoachSuggest(data.suggest);
        speakEnglish(data.npc);
    } catch (e) {
        console.error(e);
        handleGeminiError(e, '대화 시작 실패');
    } finally {
        btn.disabled = false;
        btn.innerHTML = '<i data-lucide="messages-square"></i><span>대화 시작</span>';
        if (window.lucide) lucide.createIcons();
    }
}

async function sendCoachReply(asHint = false) {
    if (!state.coach.situation) {
        showToast('먼저 대화를 시작해 주세요.');
        return;
    }
    const input = document.getElementById('coach-user-input');
    const userText = (input?.value || '').trim();
    if (!asHint && !userText) {
        showToast('영어 대답을 입력해 주세요.');
        return;
    }

    const btn = document.getElementById(asHint ? 'btn-coach-hint' : 'btn-coach-send');
    btn.disabled = true;
    try {
        if (!asHint) {
            state.coach.turns.push({ role: 'user', text: userText });
            input.value = '';
            renderCoachChat();
        }
        const history = state.coach.turns.map(t => `${t.role}: ${t.text}`).join('\n');
        const data = await callGeminiJson(`
영어 회화 코치입니다. 상황: "${state.coach.situation}" (카테고리: ${state.coach.cat})
대화 기록:
${history}

요청: ${asHint ? '사용자가 막혔습니다. 바로 쓸 수 있는 영어 대답 예시와 짧은 설명을 주세요. NPC 대사는 이어가지 말고 힌트만.' : '사용자 영어를 짧게 피드백하고, NPC로서 자연스럽게 다음 대사를 이어가세요.'}

JSON만:
{
  "feedback": "한국어 피드백 (틀린 점/더 자연스러운 표현)",
  "npc": "상대의 다음 영어 대사 (힌트 모드면 빈 문자열)",
  "suggest": { "en": "저장할 추천 영어", "ko": "뜻", "tip": "팁" }
}
`);
        if (data.feedback) state.coach.turns.push({ role: 'coach', text: data.feedback });
        if (data.npc) {
            state.coach.turns.push({ role: 'npc', text: data.npc });
            speakEnglish(data.npc);
        }
        renderCoachChat();
        if (data.suggest?.en) showCoachSuggest(data.suggest);
    } catch (e) {
        console.error(e);
        handleGeminiError(e, '대화 실패');
    } finally {
        btn.disabled = false;
    }
}

function resetCoach() {
    state.coach = { situation: '', cat: 'travel', turns: [], suggest: null };
    document.getElementById('coach-chat')?.classList.add('hidden');
    document.getElementById('coach-reply-box')?.classList.add('hidden');
    document.getElementById('coach-suggest')?.classList.add('hidden');
    const chat = document.getElementById('coach-chat');
    if (chat) chat.innerHTML = '';
    showToast('대화를 초기화했습니다.');
}

async function runCorrection() {
    const en = document.getElementById('correct-en')?.value.trim();
    const ko = document.getElementById('correct-ko')?.value.trim();
    if (!en) {
        showToast('교정할 영어 문장을 입력해 주세요.');
        return;
    }
    const tone = document.querySelector('.correct-tone-btn.selected')?.dataset.tone || 'general';
    const btn = document.getElementById('btn-correct');
    btn.disabled = true;
    btn.innerHTML = '<i data-lucide="loader-2" class="spin"></i> 교정 중...';
    if (window.lucide) lucide.createIcons();

    try {
        const data = await callGeminiJson(`
영어 교정 멘토입니다.
사용자 영어: "${en}"
의도(한국어, 선택): "${ko || '없음'}"
톤: ${tone} (official/general/casual)

JSON만 응답:
{
  "en": "교정된 자연스러운 영어",
  "ko": "한글 뜻",
  "feedback": "무엇이 어색했는지, 왜 고쳤는지 (한국어)",
  "ex": "A: ... B: ... 짧은 대화 예문"
}
`);
        document.getElementById('correct-result-en').textContent = data.en || '';
        document.getElementById('correct-result-ko').textContent = data.ko || '';
        document.getElementById('correct-result-feedback').textContent = data.feedback || '';
        let spacedEx = (data.ex || '');
        spacedEx = spacedEx.replace(/\s*([A-Z]:)/g, '\n\n$1').trim();
        document.getElementById('correct-result-ex').innerText = spacedEx;
        document.getElementById('correct-result')?.classList.remove('hidden');
    } catch (e) {
        console.error(e);
        handleGeminiError(e, '교정 실패');
    } finally {
        btn.disabled = false;
        btn.innerHTML = '<i data-lucide="spell-check"></i><span>교정받기</span>';
        if (window.lucide) lucide.createIcons();
    }
}

function normalizeDictation(text) {
    return (text || '')
        .toLowerCase()
        .replace(/[^\w\s']/g, '')
        .replace(/\s+/g, ' ')
        .trim();
}

function pickDictationCard() {
    const pool = state.allCards.filter(c => c.en && c.done !== true);
    if (!pool.length) return null;
    return pool[Math.floor(Math.random() * pool.length)];
}

function startDictation(card = null) {
    const picked = card || pickDictationCard();
    if (!picked) {
        showToast('받아쓰기할 카드가 없습니다.');
        return;
    }
    state.dictation = { card: picked, revealed: false };
    const area = document.getElementById('dictation-area');
    const input = document.getElementById('dictation-input');
    const feedback = document.getElementById('dictation-feedback');
    const nextBtn = document.getElementById('btn-dictation-next');
    area?.classList.remove('hidden');
    feedback?.classList.add('hidden');
    nextBtn?.classList.add('hidden');
    if (input) input.value = '';
    speakEnglish(picked.en);
    showToast('잘 듣고 받아 적어 보세요.');
}

function replayDictation(slow = false) {
    if (!state.dictation.card) {
        showToast('먼저 새 문제를 시작해 주세요.');
        return;
    }
    if (slow) {
        // temporarily slower via utterance rate in speakEnglish - add optional rate param
        speakEnglish(state.dictation.card.en, 0.75);
    } else {
        speakEnglish(state.dictation.card.en);
    }
}

function checkDictation() {
    const card = state.dictation.card;
    if (!card) return;
    const input = document.getElementById('dictation-input')?.value || '';
    const answer = normalizeDictation(card.en);
    const typed = normalizeDictation(input);
    const feedback = document.getElementById('dictation-feedback');
    const nextBtn = document.getElementById('btn-dictation-next');
    if (!typed) {
        showToast('답을 입력해 주세요.');
        return;
    }

    const ok = typed === answer;
    state.dictation.revealed = true;
    scheduleSrs(card.id, ok ? 3 : 0);
    refreshReviewSummary();

    if (feedback) {
        feedback.classList.remove('hidden', 'ok', 'bad');
        feedback.classList.add(ok ? 'ok' : 'bad');
        feedback.innerHTML = ok
            ? `<strong>정답!</strong><br>${card.en}<br><span style="opacity:.85">${card.ko || ''}</span>`
            : `<strong>아쉬워요.</strong><br>내 답: ${input}<br>정답: <strong>${card.en}</strong><br>${card.ko || ''}`;
    }
    nextBtn?.classList.remove('hidden');
    showToast(ok ? '훌륭해요! 🔥' : '정답을 확인해 보세요.');
}

// --- AI Buddy Logic ---
async function handleAiGenerate() {
    const inputKo = aiInputKo.value.trim();
    const inputEn = aiInputEn.value.trim();

    if (!inputKo) { showToast('한국어 의도를 먼저 입력해주세요!'); return; }

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
        const data = await callGeminiJson(prompt);
        aiResultEn.textContent = data.en;
        aiResultKo.textContent = data.ko;
        aiResultUsage.textContent = data.usage;
        let spacedEx = (data.ex || '');
        spacedEx = spacedEx.replace(/\s*([A-Z]:)/g, '\n\n$1').trim();
        aiResultEx.innerText = spacedEx;
        aiResult.classList.remove('hidden');
        btnAddToPocket.disabled = false;
        btnAddToPocket.textContent = '학습 포켓에 넣기';
    } catch (e) {
        console.error('AI Buddy Detailed Error:', e);
        handleGeminiError(e, '에러');
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
        renderMyList();
        if (typeof internalUpdateCategory === 'function') internalUpdateCategory(state.currentCategory);
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
        renderMyList();
        if (typeof internalUpdateCategory === 'function') internalUpdateCategory(state.currentCategory);
        showToast("삭제되었습니다.");
    }
};

init();
