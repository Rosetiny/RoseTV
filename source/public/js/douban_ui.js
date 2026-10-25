// This file will contain functions responsible for rendering UI elements for Douban features.
// Functions to be moved here include:
// - renderDoubanMovieTvSwitch
// - renderDoubanTags
// - renderCategoryGridCards
// - renderDoubanSearchResultsGrid
// - Parts of loadNextBatchOfHomePageTags related to DOM creation
// - UI helpers for the new filter system

console.log('douban_ui.js loaded');

function fillSearchInput(title) {
    if (!title) return;
    const safeTitle = title.replace(/</g, '<').replace(/>/g, '>').replace(/"/g, '"');
    const input = document.getElementById('searchInput');
    if (input) {
        input.value = safeTitle;
        input.focus();
        showToast('已填充搜索内容，点击搜索按钮开始搜索', 'info');
    }
}

function fillAndSearch(title) {
    if (!title) return;
    const safeTitle = title.replace(/</g, '<').replace(/>/g, '>').replace(/"/g, '"');
    const input = document.getElementById('searchInput');
    if (input) {
        input.value = safeTitle;
        search(); 
    }
}

// Note: fillAndSearchWithDouban depends on global 'selectedAPIs', 'updateSelectedAPIs', 
// 'activeDoubanSearchFilterTag', 'currentDoubanSearchFilterPageStart', 
// 'noMoreDoubanSearchFilterItems', 'isLoadingDoubanSearchFilterItems', 'search', 'navigateToTab'
// These will need to be accessible or passed.
async function fillAndSearchWithDouban(title) {
    if (!title) return;
    const safeTitle = title.replace(/</g, '<').replace(/>/g, '>').replace(/"/g, '"');
    const input = document.getElementById('searchInput');
    if (input) {
        input.value = safeTitle;
        
        if (typeof navigateToTab === 'function') navigateToTab('search');
        
        // These globals will be managed by douban_logic.js
        if (typeof activeDoubanSearchFilterTag !== 'undefined') activeDoubanSearchFilterTag = '';
        if (typeof currentDoubanSearchFilterPageStart !== 'undefined') currentDoubanSearchFilterPageStart = 0;
        if (typeof noMoreDoubanSearchFilterItems !== 'undefined') noMoreDoubanSearchFilterItems = true; 
        if (typeof isLoadingDoubanSearchFilterItems !== 'undefined') isLoadingDoubanSearchFilterItems = false;

        const resultsDiv = document.getElementById('results');
        if (resultsDiv) {
            resultsDiv.className = 'grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 2xl:grid-cols-6 gap-4';
        }

        await search(); 
        
        if (window.innerWidth <= 768) window.scrollTo({ top: 0, behavior: 'smooth' });
    }
}


// Depends on: doubanMovieTvCurrentSwitch, doubanCurrentTag, renderDoubanTags, initHomePageDoubanContent (from douban_logic.js)
function renderDoubanMovieTvSwitch() {
    const movieToggle = document.getElementById('douban-movie-toggle');
    const tvToggle = document.getElementById('douban-tv-toggle');
    if (!movieToggle || !tvToggle) return;
    const switchType = (newType) => {
        if (doubanMovieTvCurrentSwitch !== newType) {
            doubanMovieTvCurrentSwitch = newType;
            doubanCurrentTag = '热门'; 
            movieToggle.classList.toggle('bg-pink-600', newType === 'movie');
            movieToggle.classList.toggle('text-white', newType === 'movie');
            movieToggle.classList.toggle('text-gray-300', newType !== 'movie');
            tvToggle.classList.toggle('bg-pink-600', newType === 'tv');
            tvToggle.classList.toggle('text-white', newType === 'tv');
            tvToggle.classList.toggle('text-gray-300', newType !== 'tv');
            renderDoubanTags(); // This function itself will be in this file
            if (typeof initHomePageDoubanContent === 'function') initHomePageDoubanContent(); 
        }
    };
    movieToggle.addEventListener('click', () => switchType('movie'));
    tvToggle.addEventListener('click', () => switchType('tv'));
}

// Renders the new comprehensive top navigation tag bar on the homepage.
// Accepts a list of tag configurations.
// Accepts forceMainView flag: if true, it ensures the main home page is shown and does not auto-navigate to a category.
// Depends on: doubanCurrentTag (global from douban_logic.js), navigateToCategoryView (global from douban_logic.js)
function renderDoubanTags(tagsToRender = [], forceMainView = false) { 
    const tagContainer = document.getElementById('douban-tags');
    if (!tagContainer) return;
    tagContainer.innerHTML = ''; 
    const fragment = document.createDocumentFragment();

    let currentActiveTagTitle;
    // 当 forceMainView 为 true 时，我们不希望任何特定分类标签被激活。
    // window.doubanCurrentTag 在这种情况下是 '__HOME__'。
    if (forceMainView || window.doubanCurrentTag === '__HOME__') {
        currentActiveTagTitle = '__HOME_ACTIVE_TAG__'; // 一个不会匹配任何真实标签的特殊值
                                                     // 或者，如果有一个“首页”按钮，可以设为那个按钮的标识
    } else {
        currentActiveTagTitle = window.doubanCurrentTag || (tagsToRender.length > 0 ? tagsToRender[0].title : '');
        // 确保 currentActiveTagTitle 在 tagsToRender 中有效，否则默认为第一个
        if (!tagsToRender.some(t => t.title === currentActiveTagTitle) && tagsToRender.length > 0) {
            currentActiveTagTitle = tagsToRender[0].title;
        }
    }
    
    tagsToRender.forEach(tagConfig => {
        const btn = document.createElement('button');
        let btnClass = 'py-1.5 px-3.5 rounded text-sm font-medium transition-all duration-300 border ';
        
        // 如果 currentActiveTagTitle 是特殊值 '__HOME_ACTIVE_TAG__'，则没有标签是活动的。
        // 否则，正常比较 tagConfig.title 和 currentActiveTagTitle。
        if (currentActiveTagTitle === '__HOME_ACTIVE_TAG__') {
            // 如果有一个通用的“首页”或“推荐”按钮，可以在这里高亮它
            // 例如: if (tagConfig.isGeneralHomeButton) { btnClass += 'active_style'; } else { btnClass += 'inactive_style'; }
            // 目前没有这种按钮，所有标签都是非活动状态
            btnClass += 'bg-[#1a1a1a] text-gray-300 hover:bg-pink-700 hover:text-white border-[#333] hover:border-white';
        } else {
            btnClass += tagConfig.title === currentActiveTagTitle ? 'bg-pink-600 text-white shadow-md border-white' : 'bg-[#1a1a1a] text-gray-300 hover:bg-pink-700 hover:text-white border-[#333] hover:border-white';
        }
        btn.className = btnClass;
        btn.textContent = tagConfig.title;
        
        btn.onclick = function() {
            // ... (onclick 逻辑基本保持不变，但需要注意 currentActiveTagTitle 的新含义) ...
            const pageHome = document.getElementById('page-home');
            const categoryViewPage = document.getElementById('page-category-view');
            const isOnCategoryView = categoryViewPage && !categoryViewPage.classList.contains('hidden');

            // 如果点击的是当前已激活的标签 (且不是特殊首页状态)，或者是在首页状态下点击了某个标签
            // 这里的逻辑需要调整以适应 __HOME_ACTIVE_TAG__
            let isClickingCurrentActive = tagConfig.title === currentActiveTagTitle;
            if (currentActiveTagTitle === '__HOME_ACTIVE_TAG__') { // 如果当前是首页状态
                isClickingCurrentActive = false; // 点击任何标签都视为导航到新分类
            }

            if (isOnCategoryView && isClickingCurrentActive) {
                // 点击已激活的分类标签 -> 返回主页瀑布流
                if (pageHome) pageHome.classList.remove('hidden');
                if (categoryViewPage) categoryViewPage.classList.add('hidden');
                
                document.querySelectorAll('#bottomNav .nav-item').forEach(item => {
                    item.classList.remove('active');
                    if (item.dataset.page === 'home') item.classList.add('active');
                });
                sessionStorage.setItem('activeTab', 'home');
                window.doubanCurrentTag = '__HOME__'; // 返回主页时，设置特殊标记
                if (typeof initHomePageDoubanContent === 'function') initHomePageDoubanContent();
                window.scrollTo(0,0);
                sessionStorage.removeItem('homePageState');
                if(typeof saveHomePageState === 'function') saveHomePageState(); // 保存新的主页状态
                renderDoubanTags(tagsToRender, true); // 重新渲染标签，并标记为强制主页视图
            } else {
                // 导航到新的分类视图 (或者从主页瀑布流导航到分类视图)
                window.doubanCurrentTag = tagConfig.title; 
                if (typeof navigateToCategoryView === 'function') {
                    navigateToCategoryView(tagConfig.title, tagConfig.typeForCatView, tagConfig);
                }
                renderDoubanTags(tagsToRender, false); // 重新渲染标签，非强制主页视图
            }
        };
        fragment.appendChild(btn);
    });
    tagContainer.appendChild(fragment);

    // 自动导航逻辑:
    // 只有当不是 forceMainView (即 doubanCurrentTag 不是 '__HOME__') 
    // 并且 currentActiveTagTitle 是一个有效的分类标签时，才尝试自动导航。
    if (!forceMainView && window.doubanCurrentTag !== '__HOME__' && currentActiveTagTitle && currentActiveTagTitle !== '__HOME_ACTIVE_TAG__') {
        const categoryViewPage = document.getElementById('page-category-view');
        if ((!categoryViewPage || categoryViewPage.classList.contains('hidden'))) {
            const homePage = document.getElementById('page-home');
            if (homePage && !homePage.classList.contains('hidden')) {
                const activeTagConfig = tagsToRender.find(t => t.title === currentActiveTagTitle);
                if (activeTagConfig && typeof navigateToCategoryView === 'function') {
                    navigateToCategoryView(activeTagConfig.title, activeTagConfig.typeForCatView, activeTagConfig);
                }
            }
        }
    }
}

// Depends on: fetchDoubanData (from douban_api.js), renderDoubanCardsAsCarousel (in this file)
function renderCarouselRow(categoryTitle, tag, type, sort = 'recommend', pageLimit = 10, pageStart = 0) {
    console.warn("renderCarouselRow called, but home page now uses waterfall. Check if this call is still needed.");
    const mainContainer = document.getElementById("douban-recommendations-container"); 
    if (!mainContainer) return;
    const sectionId = `carousel-section-${type}-${categoryTitle.replace(/[^a-zA-Z0-9]/g, '-')}-${tag.replace(/[^a-zA-Z0-9]/g, '-')}`;
    let section = document.getElementById(sectionId);
    if (!section) {
        section = document.createElement('section');
        section.id = sectionId;
        section.className = 'carousel-section space-y-3'; 
        mainContainer.appendChild(section);
    }
    const safeCategoryTitle = categoryTitle.replace(/</g, '<').replace(/>/g, '>');
    section.innerHTML = `
        <div class="flex justify-between items-center px-1">
            <h2 class="text-xl font-semibold text-white">${safeCategoryTitle}</h2>
        </div>
        <div class="carousel-container overflow-x-auto pb-2">
            <div id="carousel-track-${sectionId}" class="carousel-track flex space-x-3">
                <div class="text-gray-400 p-4">加载中...</div>
            </div>
        </div>`;
    const carouselTrack = section.querySelector(`#carousel-track-${sectionId}`);
    const doubanApiBase = 'https://movie.douban.com'; // This might move to douban_api.js as a constant
    const targetUrl = `${doubanApiBase}/j/search_subjects?type=${type}&tag=${encodeURIComponent(tag)}&sort=${sort}&page_limit=${pageLimit}&page_start=${pageStart}`;
    
    if (typeof fetchDoubanData === 'function') {
        fetchDoubanData(targetUrl)
            .then(data => renderDoubanCardsAsCarousel(data, carouselTrack, type, tag)) 
            .catch(error => {
                console.error(`获取豆瓣数据失败 (Category: ${categoryTitle}, Tag: ${tag}, Type: ${type}, URL: ${targetUrl}):`, error);
                if(carouselTrack) carouselTrack.innerHTML = `<div class="text-red-400 p-4">❌ 加载 ${safeCategoryTitle} 失败</div>`;
            });
    } else {
        console.error('fetchDoubanData function not available in douban_ui.js for renderCarouselRow');
        if(carouselTrack) carouselTrack.innerHTML = `<div class="text-red-400 p-4">❌ 加载 ${safeCategoryTitle} 失败 (API Error)</div>`;
    }
}

// Depends on: PROXY_URL (global or from config.js), fillAndSearchWithDouban (in this file)
function renderDoubanCardsAsCarousel(data, carouselTrackElement, type, tagForContext) {
    if (!carouselTrackElement) return;
    const fragment = document.createDocumentFragment();
    if (!data || !data.subjects || !Array.isArray(data.subjects) || data.subjects.length === 0) { 
        carouselTrackElement.innerHTML = `<div class="text-gray-400 p-4">暂无内容</div>`;
        return;
    }
    data.subjects.forEach(item => { 
        const card = document.createElement("div");
        card.className = "flex-shrink-0 w-36 sm:w-40 bg-[#111] hover:bg-[#222] transition-all duration-300 rounded-lg overflow-hidden flex flex-col transform hover:scale-105 shadow-md hover:shadow-lg";
        const safeTitle = item.title.replace(/</g, '<').replace(/>/g, '>').replace(/"/g, '"');
        const safeRate = (item.rate || "暂无").replace(/</g, '<').replace(/>/g, '>');
        let originalCoverUrl = item.cover || 'image/nomedia.png';
        if (originalCoverUrl && originalCoverUrl.includes('doubanio.com')) {
            originalCoverUrl = originalCoverUrl.replace(/@.*?$/, '');
        }
        let proxiedCoverUrl = 'image/nomedia.png';
        if (typeof PROXY_URL !== 'undefined' && PROXY_URL && item.cover) {
            proxiedCoverUrl = PROXY_URL + encodeURIComponent(item.cover);
        }
        card.innerHTML = `
            <div class="relative w-full aspect-[2/3] overflow-hidden cursor-pointer" onclick="fillAndSearchWithDouban('${safeTitle}')">
                <img src="${originalCoverUrl}" alt="${safeTitle}" 
                    class="w-full h-full object-cover transition-transform duration-300 hover:scale-105"
                    onerror="this.onerror=null; this.src='${proxiedCoverUrl}'; this.classList.add('object-contain');"
                    loading="lazy" referrerpolicy="no-referrer">
                <div class="absolute inset-0 bg-gradient-to-t from-black/70 to-transparent"></div>
                <div class="absolute bottom-1 left-1 bg-black/60 text-white text-xs px-1.5 py-0.5 rounded">
                    <span class="text-yellow-400">★</span> ${safeRate}
                </div>
            </div>
            <div class="p-1.5 text-center bg-[#111]">
                <button onclick="fillAndSearchWithDouban('${safeTitle}')" 
                        class="text-xs font-medium text-white truncate w-full hover:text-pink-400 transition leading-tight"
                        title="${safeTitle}">
                    ${safeTitle}
                </button>
            </div>
        `;
        fragment.appendChild(card);
    });
    carouselTrackElement.innerHTML = ""; 
    carouselTrackElement.appendChild(fragment);
}

// Depends on: PROXY_URL (global or from config.js), fillAndSearchWithDouban (in this file)
function doubanPosterItem(item) {
    const picture = item.pic || item.images || {};
    let original = item.cover_url || item.cover || picture.large || picture.normal || picture.small || item.vod_pic || '';
    if (typeof original === 'object') original = original.url || '';
    original = String(original).replace(/@.*$/, '');
    const bridge = window.ROSETV_BRIDGE;
    return {
        vod_name: String(item.title || item.vod_name || '未知影片'),
        vod_pic: original.startsWith('http') && bridge?.enabled ? bridge.mediaURL(original) : original,
        original_pic: original,
        vod_douban_score: item.rate || item.rating?.value || '',
        vod_year: item.year || '',
        vod_remarks: '',
        type_name: (item.card_subtitle || '').split('/').slice(1, 3).join(' / ')
    };
}
function renderCategoryGridCards(data, gridContainer) {
    if (!gridContainer) return;
    initRoseBrowseStyle();
    const rows = data?.subjects || [];
    if (!rows.length) return;
    const fragment = document.createDocumentFragment();
    for (const item of rows) {
        const normalized = doubanPosterItem(item);
        const card = rosePoster(normalized);
        card.dataset.doubanTitle = normalized.vod_name;
        fragment.append(card);
    }
    gridContainer.append(fragment);
    if (!window.roseFilterPosterDelegate) {
        window.roseFilterPosterDelegate = true;
        document.addEventListener('click', event => {
            const card = event.target.closest('[data-douban-title]');
            if (card) fillAndSearchWithDouban(card.dataset.doubanTitle);
        });
    }
}
function renderDoubanSearchResultsGrid(data, gridContainer) {
    renderCategoryGridCards(data, gridContainer);
}
