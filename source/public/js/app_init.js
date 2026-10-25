window.addEventListener('pageshow', function(event) {
    const lastSearchQuery = sessionStorage.getItem('lastSearchQuery');
    const lastPageView = sessionStorage.getItem('lastPageView');

    console.log('[Pageshow] Event:', event.type, 'Persisted:', event.persisted, 'LastPageView:', lastPageView, 'Query:', lastSearchQuery);

    if (lastPageView === 'searchResults' && lastSearchQuery) {
        document.getElementById('searchInput').value = lastSearchQuery;
        if (event.persisted) {
            // Page restored from bfcache, search results should be in DOM.
            // Ensure correct UI visibility.
            console.log('[Pageshow-bfcache] Restoring search results view for query:', lastSearchQuery);
            document.getElementById('searchArea').classList.remove('flex-1');
            document.getElementById('searchArea').classList.add('mb-8');
            document.getElementById('resultsArea').classList.remove('hidden');
            const doubanArea = document.getElementById('doubanArea');
            if (doubanArea) doubanArea.classList.add('hidden');
        } else {
            // This is a full page load (not from bfcache).
            // initializeApp will handle re-running the search if necessary.
            console.log('[Pageshow-fullload] Search results were expected. initializeApp should handle re-search.');
        }
    } else {
        // Expected Douban home view or no specific state.
        if (event.persisted) {
             console.log('[Pageshow-bfcache] Restoring default/Douban view.');
            // Ensure default UI visibility if restored from bfcache
            document.getElementById('searchArea').classList.add('flex-1');
            document.getElementById('searchArea').classList.remove('mb-8');
            document.getElementById('resultsArea').classList.add('hidden');
            if (typeof updateDoubanVisibility === 'function') {
                updateDoubanVisibility();
            }
        } else {
            // Full load, initializeApp will set default Douban view.
            console.log('[Pageshow-fullload] Default/Douban view expected. initializeApp will handle.');
        }
    }
});

// Function to initialize the application after Tauri APIs are ready
function initializeApp() {
    console.log("[AppInit] Tauri API ready, initializing app.");
    // 初始化API复选框
    // initAPICheckboxes(); // Moved to api_management.js
    if (typeof initAPICheckboxes === 'function') initAPICheckboxes(); else console.error("initAPICheckboxes not found");
    
    // 初始化自定义API列表
    // renderCustomAPIsList(); // Moved to api_management.js
    if (typeof renderCustomAPIsList === 'function') renderCustomAPIsList(); else console.error("renderCustomAPIsList not found");
    
    // 初始化显示选中的API数量
    // updateSelectedApiCount(); // Moved to api_management.js
    if (typeof updateSelectedApiCount === 'function') updateSelectedApiCount(); else console.error("updateSelectedApiCount not found");
    
    // 渲染搜索历史
    if (typeof renderSearchHistory === 'function') renderSearchHistory(); else console.warn("renderSearchHistory not found, assuming it's in another module like ui.js or history.js");
    
    // 设置默认API选择（如果是第一次加载）
    if (!localStorage.getItem('hasInitializedDefaults')) {
        // 仅选择天涯资源、暴风资源和如意资源
        selectedAPIs = ["tyyszy","xiaomaomi", "bfzy","dyttzy", "ruyi"];
        localStorage.setItem('selectedAPIs', JSON.stringify(selectedAPIs));
        
        // 默认选中过滤开关
        localStorage.setItem('yellowFilterEnabled', 'true');
        localStorage.setItem(PLAYER_CONFIG.adFilteringStorage, 'true'); // Assuming PLAYER_CONFIG is global or defined elsewhere
        
        // 默认启用豆瓣功能
        localStorage.setItem('doubanEnabled', 'true');
        // 默认关闭新旧豆瓣API模式（即使用旧API）
        localStorage.setItem('doubanApiMode', 'false');

        // 标记已初始化默认值
        localStorage.setItem('hasInitializedDefaults', 'true');
    }
    
    // 设置黄色内容过滤开关初始状态
    const yellowFilterToggle = document.getElementById('yellowFilterToggle');
    if (yellowFilterToggle) {
        yellowFilterToggle.checked = localStorage.getItem('yellowFilterEnabled') === 'true';
    }
    
    // 设置广告过滤开关初始状态
    const adFilterToggle = document.getElementById('adFilterToggle');
    if (adFilterToggle) {
        // Assuming PLAYER_CONFIG is global or defined elsewhere
        adFilterToggle.checked = localStorage.getItem(PLAYER_CONFIG.adFilteringStorage) !== 'false'; // 默认为true
    }

    // 设置豆瓣API模式开关初始状态
    const doubanApiModeToggle = document.getElementById('doubanApiModeToggle');
    if (doubanApiModeToggle) {
        const useNewAndOldApi = localStorage.getItem('doubanApiMode') !== 'false'; // Default true
        doubanApiModeToggle.checked = useNewAndOldApi;
        const toggleBg = doubanApiModeToggle.nextElementSibling;
        const toggleDot = toggleBg ? toggleBg.nextElementSibling : null;
        if (toggleBg && toggleDot) {
            if (useNewAndOldApi) {
                toggleBg.classList.add('bg-pink-600');
                toggleDot.classList.add('translate-x-6');
            } else {
                toggleBg.classList.remove('bg-pink-600');
                toggleDot.classList.remove('translate-x-6');
            }
        }
    }
    
    // 设置事件监听器
    // setupEventListeners(); // Moved to app_event_listeners.js
    if (typeof setupEventListeners === 'function') setupEventListeners(); else console.error("setupEventListeners not found");
    
    // 初始检查成人API选中状态
    // setTimeout(checkAdultAPIsSelected, 100); // Moved to api_management.js, will be called after initAPICheckboxes
    if (typeof checkAdultAPIsSelected === 'function') setTimeout(checkAdultAPIsSelected, 100); else console.error("checkAdultAPIsSelected not found");


    // Manually call initDouban from app.js after API is ready and other initializations
    if (typeof initDouban === 'function') {
        // Initialize a global flag for player return, if not already present
        if (typeof window.justReturnedFromPlayer === 'undefined') {
            window.justReturnedFromPlayer = false;
        }
        initDouban();
    } else {
        console.warn("[AppInit] initDouban function not found.");
    }

    const lastSearchQuery = sessionStorage.getItem('lastSearchQuery');
    const lastPageView = sessionStorage.getItem('lastPageView');
    // 获取由 initializeNavigation (ui.js) 设定的当前活动标签页
    const currentActiveTab = sessionStorage.getItem('activeTab') || 'home';

    if (currentActiveTab === 'search' && lastSearchQuery && lastPageView === 'searchResults') {
        // 如果活动标签页是“搜索”，并且之前有搜索记录，则恢复搜索状态
        console.log('[InitializeApp] Active tab is SEARCH, and last view was search results. Restoring search:', lastSearchQuery);
        document.getElementById('searchInput').value = lastSearchQuery;
        if (typeof search === 'function') {
            search();
        } else {
            console.error("search function not found");
        }
    } else if (currentActiveTab === 'home') {
        // 如果活动标签页是“首页”
        console.log('[InitializeApp] Active tab is HOME. Ensuring Douban content is initialized if needed.');
        // navigateToTab('home') 内部会调用 restoreHomePageState。
        // initDouban 可能需要在这里被调用，以确保在没有有效状态被恢复时（例如首次加载或状态被清除后）首页内容能被正确加载。
        
        let homeRestoredSuccessfully = false;
        // Check if restoreNewPageState (from ui.js) was successful for 'home'
        // This is a bit indirect as initializeApp runs after navigateToTab has already called restoreNewPageState.
        // We assume that if sessionStorage for HOME_PAGE_STATE_KEY exists and was valid, it was restored.
        // HOME_PAGE_STATE_KEY is 'homePageState' (defined in ui.js, assumed here)
        const homePageStateRaw = sessionStorage.getItem('homePageState'); 
        if (homePageStateRaw) {
            try {
                const homePageState = JSON.parse(homePageStateRaw);
                // A simple check: if HTML was restored, or category view was restored.
                if ((homePageState.viewMode === 'main' && homePageState.homePageHTML) || homePageState.viewMode === 'category') {
                    homeRestoredSuccessfully = true;
                    console.log('[InitializeApp] Home page state seems to have been restored by navigateToTab.');
                }
            } catch (e) {
                console.warn('[InitializeApp] Could not parse homePageState for check.');
            }
        }
        
        if (!homeRestoredSuccessfully && typeof initDouban === 'function') {
            // 如果首页状态没有被成功恢复（例如，没有保存的状态，或状态无效），则初始化首页内容。
            console.log('[InitializeApp] Home state not fully restored or absent, calling initDouban to populate.');
            initDouban(); 
        } else if (!homeRestoredSuccessfully) {
             console.warn("[InitializeApp] initDouban function not found, and home state not restored/absent.");
        }
    }
    // For 'filter', 'history', 'settings' etc., their content initialization
    // is typically handled within their respective navigateToTab calls in ui.js (e.g., loadViewingHistory)
    // or they are simple enough not to need specific re-initialization here beyond what navigateToTab does.
    console.log('[InitializeApp] Finished specific initializations based on active tab:', currentActiveTab);
}

// Wait for Tauri API to be ready before initializing the app
function whenTauriApiReady(callback) {
    // Check if tauriConstants and its invoke method are available
    // tauriConstants is defined in apiUtils.js and should be loaded before app.js
    if (typeof tauriConstants !== 'undefined' && tauriConstants.invoke) {
        console.log("[AppInit] Tauri API (via tauriConstants.invoke) is immediately available.");
        callback();
    } else {
        let attempts = 0;
        const maxAttempts = 100; // Reverted to 10 seconds timeout
        const intervalTime = 100; // Check every 100ms
        console.log("[AppInit] Tauri API (via tauriConstants.invoke) not immediately available. Starting polling...");
        const interval = setInterval(() => {
            attempts++;
            // Simplified logging, closer to what might have been original or less intrusive
            if (attempts === 1 || attempts % 50 === 0 || attempts === maxAttempts) { // Log less frequently
                console.log(`[AppInit Polling Attempt ${attempts}] Checking for tauriConstants.invoke...`);
                if (typeof tauriConstants !== 'undefined' && tauriConstants.invoke) {
                     console.log(`[AppInit Polling Attempt ${attempts}] tauriConstants.invoke is now available.`);
                } else {
                     console.log(`[AppInit Polling Attempt ${attempts}] tauriConstants.invoke is still NOT available.`);
                }
            }

            if (typeof tauriConstants !== 'undefined' && tauriConstants.invoke) {
                clearInterval(interval);
                console.log(`[AppInit] Tauri API (via tauriConstants.invoke) became available after ${attempts} attempts.`);
                callback();
            } else if (attempts >= maxAttempts) {
                clearInterval(interval);
                console.error("[AppInit] Tauri API (via tauriConstants.invoke) did not become available after " + (maxAttempts * intervalTime / 1000) + " seconds. App might not function correctly.");
                callback(); 
            }
        }, intervalTime);
    }
}

// 页面初始化
document.addEventListener('DOMContentLoaded', function() {
    console.log("[AppInit] DOMContentLoaded event fired.");
    whenTauriApiReady(initializeApp);
});
