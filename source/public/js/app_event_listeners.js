// 设置事件监听器
function setupEventListeners() {
    // 回车搜索
    const searchInput = document.getElementById('searchInput');
    if (searchInput) {
        searchInput.addEventListener('keypress', function(e) {
            if (e.key === 'Enter') {
                if (typeof search === 'function') search(); else console.error("search function not found for Enter key press");
            }
        });
    }
    
    // 黄色内容过滤开关事件绑定
    const yellowFilterToggle = document.getElementById('yellowFilterToggle');
    if (yellowFilterToggle) {
        yellowFilterToggle.addEventListener('change', function(e) {
            localStorage.setItem('yellowFilterEnabled', e.target.checked);

            // 控制黄色内容接口的显示状态
            const adultdiv = document.getElementById('adultdiv');
            if (adultdiv) {
                if (e.target.checked === true) {
                    adultdiv.style.display = 'none';
                } else if (e.target.checked === false) {
                    adultdiv.style.display = ''; // Reset to default display
                }
            } else {
                // If adultdiv doesn't exist, try to add it (might be hidden initially)
                if (typeof addAdultAPI === 'function') addAdultAPI(); else console.error("addAdultAPI function not found");
            }
             // Re-check adult API selections as filter state change might affect this
            if (typeof checkAdultAPIsSelected === 'function') checkAdultAPIsSelected(); else console.error("checkAdultAPIsSelected function not found");
        });
    }
    
    // 广告过滤开关事件绑定
    const adFilterToggle = document.getElementById('adFilterToggle');
    if (adFilterToggle) {
        adFilterToggle.addEventListener('change', function(e) {
            // Assuming PLAYER_CONFIG is global or defined elsewhere
            localStorage.setItem(PLAYER_CONFIG.adFilteringStorage, e.target.checked);
        });
    }

    // 豆瓣API模式开关事件绑定
    const doubanApiModeToggle = document.getElementById('doubanApiModeToggle');
    if (doubanApiModeToggle) {
        doubanApiModeToggle.addEventListener('change', function(e) {
            const isChecked = e.target.checked;
            localStorage.setItem('doubanApiMode', isChecked); // Stores "true" or "false" as strings

            const toggleBg = e.target.nextElementSibling;
            const toggleDot = toggleBg ? toggleBg.nextElementSibling : null;
            if (toggleBg && toggleDot) {
                if (isChecked) {
                    toggleBg.classList.add('bg-pink-600');
                    toggleDot.classList.add('translate-x-6');
                } else {
                    toggleBg.classList.remove('bg-pink-600');
                    toggleDot.classList.remove('translate-x-6');
                }
            }
            sessionStorage.removeItem('homePageState'); 

            for (let i = 0; i < sessionStorage.length; i++) {
                const key = sessionStorage.key(i);
                if (key && key.startsWith('douban_api_cache_')) {
                    sessionStorage.removeItem(key);
                    i--; 
                }
            }
            if (typeof showToast === 'function') showToast('豆瓣API模式已更新。相关内容将在下次访问时刷新以应用更改。', 'info'); else console.log('Douban API mode updated.');
        });
    }
}

// 重置搜索区域 (Now primarily means navigating to home tab)
function resetSearchArea() {
    if (typeof navigateToTab === 'function') {
        navigateToTab('home');
    } else {
        console.warn('navigateToTab function not found for resetSearchArea');
        // Fallback or legacy behavior
        const searchResultsEl = document.getElementById('results');
        if (searchResultsEl) searchResultsEl.innerHTML = '';
        
        const searchInputEl = document.getElementById('searchInput');
        if (searchInputEl) searchInputEl.value = '';
        
        const searchAreaEl = document.getElementById('searchArea');
        if (searchAreaEl) {
             searchAreaEl.classList.add('flex-1'); 
             searchAreaEl.classList.remove('mb-8'); 
        }
       
        const resultsAreaEl = document.getElementById('resultsArea');
        if (resultsAreaEl) resultsAreaEl.classList.add('hidden');
        
        sessionStorage.setItem('lastPageView', 'doubanHome'); 
    }
    
    // Douban visibility is handled by navigateToTab('home') and initDouban logic
    // if (typeof updateDoubanVisibility === 'function') {
    //     updateDoubanVisibility(); 
    // }
}
