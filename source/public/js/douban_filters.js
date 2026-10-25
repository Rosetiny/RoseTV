console.log('douban_filters.js loaded');

// For New API
const doubanFilterOptions = {
    contentType: { 
        paramName: 'tags', 
        label: '筛选内容',
        options: ['全部', '电影', '电视剧', '综艺', '动画', '纪录片', '短片']
    },
    theme: { 
        paramName: 'genres', 
        label: '筛选主题',
        options: ['全部', '喜剧', '爱情', '动作', '科幻', '动画', '悬疑', '犯罪', '惊悚', '冒险', '音乐', '历史', '奇幻', '恐怖', '战争', '传记', '歌舞', '武侠', '情色', '灾难', '西部', '纪录片', '短片']
    },
    region: { 
        paramName: 'countries', 
        label: '地区',
        options: ['全部', '中国大陆', '美国', '香港', '台湾', '日本', '韩国', '英国', '法国', '德国', '意大利', '西班牙', '印度', '泰国', '俄罗斯', '伊朗', '加拿大', '澳大利亚', '爱尔兰', '瑞典', '巴西', '丹麦']
    },
    sortBy: { // For New API
        paramName: 'sort',
        label: '排序方式',
        options: [ { name: '按热度排序', value: 'T' }, { name: '按时间排序', value: 'R' }, { name: '按评分排序', value: 'S' } ],
        defaultValue: 'S' 
    }
};

// State for New API filters
window.currentSearchPageFilters = {
    tags: '', 
    genres: '',
    countries: '',
    sort: doubanFilterOptions.sortBy.defaultValue, 
    start: 0,
    range: '0,10' 
};

// State for Old API filters
window.currentOldApiFilters = {
    selectedContentType: '电影', 
    selectedTheme: '热门',       
    selectedRegion: '',      // Region filter is removed, but keep state for consistency
    apiType: 'movie',        // Will be derived from '电影'
    apiTag: '电影',          // Base tag for '电影', will be overridden by selectedTheme '热门'
    sort: 'recommend',       // Default to '综合排序'
    start: 0
};

// User-added tags for the Old API filter
window.userAddedOldApiTags = [];
const USER_ADDED_TAGS_STORAGE_KEY = 'doubanUserAddedOldApiTags';

function loadUserAddedOldApiTags() {
    const storedTags = localStorage.getItem(USER_ADDED_TAGS_STORAGE_KEY);
    if (storedTags) {
        try {
            window.userAddedOldApiTags = JSON.parse(storedTags);
        } catch (e) {
            console.error('Error parsing user-added tags:', e);
            window.userAddedOldApiTags = [];
        }
    } else {
        window.userAddedOldApiTags = [];
    }
}

function saveUserAddedOldApiTags() {
    try {
        localStorage.setItem(USER_ADDED_TAGS_STORAGE_KEY, JSON.stringify(window.userAddedOldApiTags));
    } catch (e) {
        console.error('Error saving user-added tags:', e);
    }
}
// Load tags when script is initialized
loadUserAddedOldApiTags();


window.DOUBAN_FILTER_ITEMS_PER_PAGE = 20; 
window.isLoadingSearchPageFilters = false;
window.noMoreSearchPageFilterItems = false;
window.allButtonGroups = []; 

function createFilterButton(text, filterKey, filterValue, isActive, clickHandler, isSpecial = false) {
    const button = document.createElement('button');
    button.textContent = text;
    button.dataset.filterKey = filterKey; 
    button.dataset.filterValue = filterValue; 
    button.className = `px-3 py-1.5 text-sm font-medium rounded-md border transition-colors duration-200 ${isActive ? 'bg-pink-600 text-white border-pink-500' : (isSpecial ? 'bg-green-600 hover:bg-green-700 text-white border-green-500' : 'bg-gray-700 text-gray-300 border-gray-600 hover:bg-gray-600 hover:text-white')}`;
    button.onclick = clickHandler;
    return button;
}

function initDoubanFilterControls(containerId) {
    const container = document.getElementById(containerId);
    if (!container) {
        console.error(`Filter container with id '${containerId}' not found.`);
        return;
    }
    container.innerHTML = ''; 
    window.allButtonGroups = []; 

    const useOnlyOldApi = localStorage.getItem('doubanApiMode') === 'false';

    if (useOnlyOldApi) {
        const savedStateRaw = sessionStorage.getItem('filterPageState');
        let restoredOldFilters = false;
        if (savedStateRaw) {
            try {
                const savedState = JSON.parse(savedStateRaw);
                if (savedState.mode === 'oldApi' && savedState.filters) {
                    // Merge saved state over defaults to ensure all properties are present
                    const defaultOldFilters = { selectedContentType: '全部', selectedTheme: '', selectedRegion: '', apiType: 'movie', apiTag: '热门', sort: 'rank', start: 0 };
                    window.currentOldApiFilters = { ...defaultOldFilters, ...savedState.filters };
                    restoredOldFilters = true;
                }
            } catch (e) { console.error("Error parsing saved filter state for old API", e); }
        }
        
        if (!restoredOldFilters) { 
            window.currentOldApiFilters = {
                selectedContentType: '全部', 
                selectedTheme: '',      
                selectedRegion: '',     
                apiType: 'movie',        
                apiTag: '热门',          
                sort: 'rank',            
                start: 0
            };
        }
        initOldApiFilterUIWithMatchedButtons(containerId);
    } else {
        // Initialize UI for New API filters
        if (!window.currentSearchPageFilters || Object.keys(window.currentSearchPageFilters).length === 0 || !sessionStorage.getItem('filterPageState')) {
             window.currentSearchPageFilters = { 
                tags: '', 
                genres: '', 
                countries: '', 
                sort: doubanFilterOptions.sortBy.defaultValue, 
                start: 0, 
                range: '0,10' 
            };
        }
        window.currentSearchPageFilters.start = 0; 

        Object.keys(doubanFilterOptions).forEach(filterConfigKey => { 
            const filterGroupConfig = doubanFilterOptions[filterConfigKey];
            const groupDiv = document.createElement('div');
            groupDiv.className = 'mb-4';
            const label = document.createElement('h4');
            label.className = 'text-lg font-semibold text-gray-300 mb-2';
            label.textContent = filterGroupConfig.label;
            groupDiv.appendChild(label);
            
            const buttonsDiv = document.createElement('div');
            buttonsDiv.className = 'flex flex-wrap gap-2';
            window.allButtonGroups.push({key: filterGroupConfig.paramName, element: buttonsDiv}); 
            
            filterGroupConfig.options.forEach(option => {
                const optionValue = typeof option === 'object' ? option.value : option;
                const optionName = typeof option === 'object' ? option.name : option;
                
                const clickHandler = () => {
                    if (optionName === '全部') {
                        window.currentSearchPageFilters[filterGroupConfig.paramName] = ''; 
                        if (filterGroupConfig.paramName === 'tags') { 
                            window.currentSearchPageFilters.tags = ''; 
                        }
                    } else {
                        window.currentSearchPageFilters[filterGroupConfig.paramName] = optionValue;
                    }
                    updateAllButtonActiveStates(); 
                    applySearchPageFilters(); 
                };
                
                let isActive = false;
                 if (filterGroupConfig.paramName === 'sort') {
                    isActive = (optionValue === window.currentSearchPageFilters.sort);
                } else if (filterGroupConfig.paramName === 'tags') { 
                    if (optionName === '全部') isActive = (window.currentSearchPageFilters.tags === '');
                    else isActive = (optionValue === window.currentSearchPageFilters.tags);
                } else { 
                    isActive = (optionValue === window.currentSearchPageFilters[filterGroupConfig.paramName]) || 
                               (optionName === '全部' && !window.currentSearchPageFilters[filterGroupConfig.paramName]);
                }

                const button = createFilterButton(optionName, filterGroupConfig.paramName, optionValue, isActive, clickHandler);
                buttonsDiv.appendChild(button);
            });
            groupDiv.appendChild(buttonsDiv);
            container.appendChild(groupDiv);
        });
    }
}

function initOldApiFilterUIWithMatchedButtons(containerId) {
    const container = document.getElementById(containerId);
    if (!container) return;
    container.innerHTML = ''; 

    // Updated defaultFilters to reflect new defaults
    const defaultFilters = { 
        selectedContentType: '电影', 
        selectedTheme: '热门', 
        selectedRegion: '', 
        apiType: 'movie', 
        apiTag: '电影', // Base tag for '电影'
        sort: 'recommend', 
        start: 0 
    };
    // Ensure currentOldApiFilters aligns with new defaults if not already set by saved state
    window.currentOldApiFilters = { ...defaultFilters, ...window.currentOldApiFilters };
    // If selectedContentType was '全部' from a saved state, it will be overridden by the find below if '全部' is removed from options.
    // Or, ensure selectedContentType is one of the valid options.
    if (window.currentOldApiFilters.selectedContentType === '全部') { // If loaded from old state
        window.currentOldApiFilters.selectedContentType = '电影'; // Force to new default
    }


    // Explicitly set apiType and apiTag based on selectedContentType after merging with defaults
    // Content Type options are now only "电影" and "电视剧"
    const oldApiPrimaryTypeOptions = [
        { name: '电影', value: '电影', apiType: 'movie', primaryTag: '电影' },
        { name: '电视剧', value: '电视剧', apiType: 'tv', primaryTag: '热门' }
    ];
    
    let currentSelectedContentTypeOpt = oldApiPrimaryTypeOptions.find(opt => opt.name === window.currentOldApiFilters.selectedContentType);
    // If current selectedContentType is not '电影' or '电视剧' (e.g. from old saved state), default to '电影'.
    if (!currentSelectedContentTypeOpt) { 
        window.currentOldApiFilters.selectedContentType = '电影'; 
        currentSelectedContentTypeOpt = oldApiPrimaryTypeOptions.find(opt => opt.name === '电影');
    }
    
    // Set apiType and base apiTag based on the (now limited) selectedContentType
    window.currentOldApiFilters.apiType = currentSelectedContentTypeOpt.apiType;
    window.currentOldApiFilters.apiTag = currentSelectedContentTypeOpt.primaryTag; // This is '电影' or '热门' (for TV)
    
    // Ensure selectedTheme defaults to '热门' if it's empty or was '全部'
    if (window.currentOldApiFilters.selectedTheme === '全部' || window.currentOldApiFilters.selectedTheme === '') {
        window.currentOldApiFilters.selectedTheme = '热门';
    }
    // If the current selectedTheme is one of the types now moved from ContentType to Tags, keep it.
    // Otherwise, if it's not a generally valid tag, it might default to '热门'.
    const commonMovieTags = ['热门', '最新', '经典', '豆瓣高分', '冷门佳片', '华语', '欧美', '韩国', '日本', '动作', '喜剧', '爱情', '科幻', '悬疑', '恐怖', '治愈', '动画', '综艺', '纪录片', '短片'];
    const commonTvTags = ['热门', '美剧', '英剧', '韩剧', '日剧', '国产剧', '港剧', '日本动画', '综艺', '纪录片', '动画', '短片']; // Added new tags here too

    if (window.currentOldApiFilters.apiType === 'movie' && !commonMovieTags.includes(window.currentOldApiFilters.selectedTheme)) {
        // window.currentOldApiFilters.selectedTheme = '热门'; // Re-evaluate if this reset is needed or if current selectedTheme is fine
    } else if (window.currentOldApiFilters.apiType === 'tv' && !commonTvTags.includes(window.currentOldApiFilters.selectedTheme)) {
        // window.currentOldApiFilters.selectedTheme = '热门';
    }


    const createOldApiButtonGroup = (label, options, currentSelectionInState, filterPropertyToUpdate, isPrimaryContentTypeGroup = false) => {
        const groupDiv = document.createElement('div');
        groupDiv.className = 'mb-4';
        groupDiv.innerHTML = `<h4 class="text-lg font-semibold text-gray-300 mb-2">${label}</h4>`;
        const buttonsDiv = document.createElement('div');
        buttonsDiv.className = 'flex flex-wrap gap-2';

        options.forEach(opt => {
            const buttonName = opt.name; 
            const buttonValue = opt.value; 
            
            // "全部" button is no longer generated for ContentType and Theme, so specific '全部' logic for isActive is not needed for them.
            // For Sort, if "全部" was an option, it would mean a default value.
            let isActive = (currentSelectionInState === buttonValue);
            if (buttonName === '全部' && (currentSelectionInState === '' || currentSelectionInState === '全部')) { // General fallback for "全部" if it exists for a category
                 isActive = true;
            }
            
            const clickHandler = () => {
                // "全部" button click logic is now only relevant if a filter group still has "全部" (e.g. sort, if it had one)
                // For ContentType and Theme, "全部" buttons are removed from options.
                if (buttonName === '全部') { 
                    if (filterPropertyToUpdate === 'sort') { // Example if sort had a "全部" meaning default
                        window.currentOldApiFilters[filterPropertyToUpdate] = 'recommend'; // Default sort
                    } else {
                         window.currentOldApiFilters[filterPropertyToUpdate] = ''; // Generic fallback for "全部"
                    }
                } else { 
                    window.currentOldApiFilters[filterPropertyToUpdate] = buttonValue;
                    if (isPrimaryContentTypeGroup) {
                        // When a specific Content Type (e.g., "电影", "电视剧") is clicked
                        const selectedOpt = oldApiPrimaryTypeOptions.find(o => o.value === buttonValue);
                        if (selectedOpt) {
                            window.currentOldApiFilters.apiType = selectedOpt.apiType;
                            window.currentOldApiFilters.apiTag = selectedOpt.primaryTag;
                        }
                        // When changing content type, reset theme to '热门' (new default for theme)
                        window.currentOldApiFilters.selectedTheme = '热门'; 
                        window.currentOldApiFilters.selectedRegion = ''; // Region is not used
                    }
                }
                initOldApiFilterUIWithMatchedButtons(containerId);
                applyOldApiFilters();
            };
            const button = createFilterButton(buttonName, filterPropertyToUpdate, buttonValue, isActive, clickHandler);
            buttonsDiv.appendChild(button);
        });
        groupDiv.appendChild(buttonsDiv);
        container.appendChild(groupDiv);
    };

    createOldApiButtonGroup('内容类型', oldApiPrimaryTypeOptions, window.currentOldApiFilters.selectedContentType, 'selectedContentType', true);

    let effectiveApiTypeForSecondaryTags = window.currentOldApiFilters.apiType; // This will be 'movie' or 'tv'

    // Define base tags and add "动画", "综艺", "纪录片", "短片" to both movie and TV tag lists.
    const additionalTags = ['动画', '综艺', '纪录片', '短片'];
    let movieSpecificTags = ['热门', '最新', '经典', '豆瓣高分', '冷门佳片', '华语', '欧美', '韩国', '日本', '动作', '喜剧', '爱情', '科幻', '悬疑', '恐怖', '治愈', '剧情', '战争', '奇幻', '冒险', '犯罪', '惊悚', '家庭', '古装', '武侠', '音乐', '歌舞', '传记', '历史', '西部', '黑色电影', '情色', '灾难', '儿童'];
    let tvSpecificTags = ['热门', '最新', '经典', '美剧', '英剧', '韩剧', '日剧', '国产剧', '港剧', '日本动画']; //综艺 and 纪录片 are already in additionalTags

    let themeTags;
    if (effectiveApiTypeForSecondaryTags === 'tv') {
        themeTags = [...new Set([...tvSpecificTags, ...additionalTags])];
    } else { // 'movie'
        themeTags = [...new Set([...movieSpecificTags, ...additionalTags])];
    }
    
    // No "全部" option for themes/tags.
    // Primary type names for exclusion are now just '电影', '电视剧'.
    // We want to ensure that if a tag like "动画" is selected, it's not filtered out if "动画" is also a primary type (which it isn't anymore).
    // The logic `!primaryTypeNamesForExclusion.includes(t)` is less relevant now for these specific tags.
    // We just need the list of available tags.
    let displayableThemeTags = [...themeTags];

    // Ensure '热门' is always an option and at the beginning if it's the default or a common choice.
    if (displayableThemeTags.includes('热门')) {
        displayableThemeTags = ['热门', ...displayableThemeTags.filter(t => t !== '热门')];
    }
    
    // Add user-added tags to the displayable list, ensuring no duplicates with predefined tags
    const combinedDisplayableTags = [...new Set([...displayableThemeTags, ...window.userAddedOldApiTags])];

    const themeOptions = combinedDisplayableTags.map(tag => ({name: tag, value: tag}));
    
    if (themeOptions.length > 0) { // Check if there are any themes to display
       createOldApiButtonGroup('标签', themeOptions, window.currentOldApiFilters.selectedTheme, 'selectedTheme', false);
    }


    // Add the "+ 添加标签" button to the "标签" group specifically
    const tagGroupDiv = Array.from(container.querySelectorAll('.mb-4')).find(div => div.querySelector('h4')?.textContent === '标签');
    if (tagGroupDiv) {
        const buttonsDiv = tagGroupDiv.querySelector('.flex.flex-wrap.gap-2');
        // Capture the current themeTags for use in the click handler
        const currentPredefinedThemeTags = [...themeTags]; // themeTags is defined earlier in this function scope

        if (buttonsDiv) {
            const addTagButton = createFilterButton('+ 添加标签', 'add_custom_tag', 'add_custom_tag', false, () => {
                console.log("'+ 添加标签' button clicked in Old API mode.");
                const customTagModal = document.getElementById('customTagModal');
                const customTagInput = document.getElementById('customTagInput');
                const confirmCustomTagBtn = document.getElementById('confirmCustomTagBtn');
                const cancelCustomTagBtn = document.getElementById('cancelCustomTagBtn');

                if (!customTagModal || !customTagInput || !confirmCustomTagBtn || !cancelCustomTagBtn) {
                    console.error('Custom tag modal elements not found!');
                    alert('添加标签功能出现错误，请刷新页面或联系开发者。');
                    return;
                }

                customTagInput.value = ''; // Clear previous input
                customTagModal.style.display = 'flex';
                customTagInput.focus();

                const handleConfirm = () => {
                    const newTagName = customTagInput.value.trim();
                    console.log("Custom modal confirm, tag name: ", newTagName);
                    if (newTagName !== '') {
                        if (!window.userAddedOldApiTags.includes(newTagName) && !currentPredefinedThemeTags.includes(newTagName)) {
                            window.userAddedOldApiTags.push(newTagName);
                            saveUserAddedOldApiTags();
                            window.currentOldApiFilters.selectedTheme = newTagName;
                            initOldApiFilterUIWithMatchedButtons(containerId);
                            applyOldApiFilters();
                        } else {
                            alert('标签已存在或与预定义标签重复。');
                        }
                    }
                    closeCustomModal();
                };

                const handleCancel = () => {
                    console.log("Custom modal cancel.");
                    closeCustomModal();
                };

                const closeCustomModal = () => {
                    customTagModal.style.display = 'none';
                    // Clean up event listeners to prevent multiple additions
                    confirmCustomTagBtn.removeEventListener('click', handleConfirm);
                    cancelCustomTagBtn.removeEventListener('click', handleCancel);
                    customTagInput.removeEventListener('keypress', handleKeyPress);
                };
                
                const handleKeyPress = (event) => {
                    if (event.key === 'Enter') {
                        handleConfirm();
                    }
                };

                // Add event listeners, ensuring they are fresh for each modal opening
                confirmCustomTagBtn.addEventListener('click', handleConfirm, { once: true });
                cancelCustomTagBtn.addEventListener('click', handleCancel, { once: true });
                customTagInput.addEventListener('keypress', handleKeyPress); // Listener will be removed in closeCustomModal

            }, true); // true for isSpecial styling
            buttonsDiv.appendChild(addTagButton);
        }
    }


    let regionTags;
    if (effectiveApiTypeForSecondaryTags === 'tv') {
        regionTags = ['全部', '国产剧', '美剧', '英剧', '韩剧', '日剧', '港剧', '内地', '欧美', '华语', '台湾', '日本', '韩国', '英国', '美国', '中国大陆'];
    } else { // movie
        regionTags = ['全部', '中国大陆', '美国', '香港', '台湾', '日本', '韩国', '英国', '法国', '德国', '意大利', '西班牙', '印度', '泰国', '俄罗斯', '加拿大', '澳大利亚', '爱尔兰', '瑞典', '巴西', '丹麦', '内地', '欧美', '华语'];
    }
    // const regionOptions = [...new Set(regionTags)].map(tag => ({name: tag, value: tag})); // Region filter removed
    // createOldApiButtonGroup('地区', regionOptions, window.currentOldApiFilters.selectedRegion, 'selectedRegion', false); // Region filter removed
    
    const sortOptionsOldApi = [
        { name: '综合排序', value: 'recommend' },
        { name: '按时间排序', value: 'time' },
        { name: '按评价排序', value: 'rank' }
        // { name: '按排行榜', value: 'chart_top_list' } // Removed as per request
    ];
    createOldApiButtonGroup('排序方式', sortOptionsOldApi, window.currentOldApiFilters.sort, 'sort', false);
}


function updateAllButtonActiveStates() { 
    const useOnlyOldApi = localStorage.getItem('doubanApiMode') === 'false';
    if (useOnlyOldApi) {
        return;
    }

    window.allButtonGroups.forEach(group => {
        const paramName = group.key;
        group.element.querySelectorAll('button').forEach(btn => {
            const btnValue = btn.dataset.filterValue;
            const btnName = btn.textContent;
            let isActive = false;
            if (paramName === 'sort') {
                isActive = (btnValue === window.currentSearchPageFilters.sort);
            } else if (paramName === 'tags') { 
                if (btnName === '全部') isActive = (window.currentSearchPageFilters.tags === '');
                else isActive = (btnValue === window.currentSearchPageFilters.tags);
            } else { 
                isActive = (btnValue === window.currentSearchPageFilters[paramName]) || (btnName === '全部' && !window.currentSearchPageFilters[paramName]);
            }
            btn.className = `px-3 py-1.5 text-sm font-medium rounded-md border transition-colors duration-200 ${isActive ? 'bg-pink-600 text-white border-pink-500' : 'bg-gray-700 text-gray-300 border-gray-600 hover:bg-gray-600 hover:text-white'}`;
        });
    });
}

async function applySearchPageFilters(isLoadingMore = false) {
    const useOnlyOldApi = localStorage.getItem('doubanApiMode') === 'false';

    if (useOnlyOldApi) {
        await applyOldApiFilters(isLoadingMore);
        return;
    }

    const resultsDiv = document.getElementById('douban-filter-items-grid'); 
    const countEl = document.getElementById('doubanFilterResultsCount');
    const loadingEl = document.getElementById('loading');

    if (!resultsDiv || !countEl) {
        console.error("Filter page result elements ('douban-filter-items-grid', 'doubanFilterResultsCount') not found.");
        if (loadingEl) loadingEl.style.display = 'none';
        window.isLoadingSearchPageFilters = false;
        return;
    }
    
    if (!isLoadingMore) {
        window.currentSearchPageFilters.start = 0; 
        window.noMoreSearchPageFilterItems = false; 
        resultsDiv.innerHTML = '<p class="col-span-full text-center text-gray-400 py-8">正在加载筛选结果...</p>';
        if (countEl) countEl.textContent = '0';
    } else if (window.isLoadingSearchPageFilters || window.noMoreSearchPageFilterItems) {
        return; 
    }
    
    window.isLoadingSearchPageFilters = true;
    if (loadingEl) loadingEl.style.display = 'flex';
    
    const paramsToFetch = {
        tags: window.currentSearchPageFilters.tags || '',
        genres: window.currentSearchPageFilters.genres || '',
        countries: window.currentSearchPageFilters.countries || '',
        sort: window.currentSearchPageFilters.sort || doubanFilterOptions.sortBy.defaultValue,
        start: window.currentSearchPageFilters.start.toString(),
        range: window.currentSearchPageFilters.range || '0,10',
    };

    console.log('Applying New API Douban Filters on Filter Page:', paramsToFetch);

    try {
        const data = await fetchNewDoubanSearch(paramsToFetch); 
        
        if (!isLoadingMore) resultsDiv.innerHTML = ''; 

        if (data && data.subjects && data.subjects.length > 0) {
            if (typeof renderDoubanSearchResultsGrid === 'function') { 
                renderDoubanSearchResultsGrid(data, resultsDiv); 
            } else {
                console.error('renderDoubanSearchResultsGrid function not found');
                resultsDiv.innerHTML += '<p class="col-span-full text-red-500">UI渲染错误</p>';
            }
            window.currentSearchPageFilters.start = parseInt(window.currentSearchPageFilters.start, 10) + data.subjects.length;
            if (countEl) countEl.textContent = isLoadingMore ? (parseInt(countEl.textContent || '0') + data.subjects.length) : data.subjects.length;
            if (data.subjects.length < window.DOUBAN_FILTER_ITEMS_PER_PAGE) {
                window.noMoreSearchPageFilterItems = true;
            }
        } else {
            if (!isLoadingMore) resultsDiv.innerHTML = '<p class="col-span-full text-center text-gray-500 py-8">没有找到符合条件的内容。</p>';
            if (countEl && !isLoadingMore) countEl.textContent = '0';
            window.noMoreSearchPageFilterItems = true;
        }
    } catch (error) {
        console.error('Error applying New API Douban filters:', error);
        if (!isLoadingMore) resultsDiv.innerHTML = '<p class="col-span-full text-center text-red-500 py-8">加载筛选结果失败。</p>';
    } finally {
        window.isLoadingSearchPageFilters = false;
        if (loadingEl) loadingEl.style.display = 'none';
    }
}

async function applyOldApiFilters(isLoadingMore = false) {
    const resultsDiv = document.getElementById('douban-filter-items-grid');
    const countEl = document.getElementById('doubanFilterResultsCount');
    const loadingEl = document.getElementById('loading');

    if (!resultsDiv || !countEl) {
        console.error("Filter page result elements for old API not found.");
        if (loadingEl) loadingEl.style.display = 'none';
        window.isLoadingSearchPageFilters = false; 
        return;
    }

    if (!isLoadingMore) {
        window.currentOldApiFilters.start = 0;
        window.noMoreSearchPageFilterItems = false; 
        resultsDiv.innerHTML = '<p class="col-span-full text-center text-gray-400 py-8">正在使用旧版API加载筛选结果...</p>';
        if (countEl) countEl.textContent = '0';
    } else if (window.isLoadingSearchPageFilters || window.noMoreSearchPageFilterItems) {
        return;
    }

    window.isLoadingSearchPageFilters = true;
    if (loadingEl) loadingEl.style.display = 'flex';

    let finalApiType = window.currentOldApiFilters.apiType;
    let finalApiTag = window.currentOldApiFilters.apiTag; // 默认使用内容类型决定的基础tag

    // "全部" is no longer a selectable state for selectedTheme.
    // selectedTheme will either be a specific tag (like "热门") or potentially empty if reset,
    // though the new default logic aims to keep it set (e.g. to "热门").
    if (window.currentOldApiFilters.selectedTheme && window.currentOldApiFilters.selectedTheme !== '全部') {
        finalApiTag = window.currentOldApiFilters.selectedTheme;
    }
    // If selectedTheme is empty (e.g. due to an unexpected state or if '热门' was not found),
    // finalApiTag remains the base tag from ContentType (e.g., '电影' if ContentType is '电影').
    
    // 如果以上条件都不满足（例如 selectedTheme 是空字符串 '' or '全部' [though '全部' shouldn't happen]),
    // finalApiTag 将保持为由内容类型决定的基础 tag (例如 '热门')。
    // If selectedContentType is "全部" and no theme/region, finalApiTag is '热门' (set by content type click or default)
    // and finalApiType is 'movie' (default for "全部" content type).

    const { sort, start } = window.currentOldApiFilters;
    const itemsPerPage = 20; 
    
    console.log('[Debug Old API Filter] Selections before URL:', JSON.stringify(window.currentOldApiFilters));
    
    // Logic for chart_top_list sort has been removed.
    // Always use the standard old API call.
    const effectiveSort = sort; // sort is already from window.currentOldApiFilters.sort
    
    console.log(`[Debug Old API Filter] Derived apiType: ${finalApiType}, Derived apiTag for URL: ${finalApiTag}, Sort: ${effectiveSort}`);
    const oldApiUrl = `https://movie.douban.com/j/search_subjects?type=${finalApiType}&tag=${encodeURIComponent(finalApiTag)}&sort=${effectiveSort}&page_limit=${itemsPerPage}&page_start=${start}`;
    console.log('Applying Old API Douban Filters on Filter Page (Search Subjects):', oldApiUrl);
    const dataPromise = fetchDoubanData(oldApiUrl);

    try {
        const data = await dataPromise;

        if (!isLoadingMore) resultsDiv.innerHTML = '';

        if (data && data.subjects && data.subjects.length > 0) {
            if (typeof renderDoubanSearchResultsGrid === 'function') {
                renderDoubanSearchResultsGrid(data, resultsDiv);
            } else {
                console.error('renderDoubanSearchResultsGrid function not found');
                resultsDiv.innerHTML += '<p class="col-span-full text-red-500">UI渲染错误</p>';
            }
            window.currentOldApiFilters.start += data.subjects.length;
            if (countEl) countEl.textContent = isLoadingMore ? (parseInt(countEl.textContent || '0') + data.subjects.length) : data.subjects.length;
            
            // The chart API might not respect page_limit exactly or might return all items.
            // For now, assume if less than itemsPerPage, it's the end.
            if (data.subjects.length < itemsPerPage) {
                window.noMoreSearchPageFilterItems = true;
            }
        } else {
            if (!isLoadingMore) resultsDiv.innerHTML = '<p class="col-span-full text-center text-gray-500 py-8">没有找到符合条件的内容。</p>';
            if (countEl && !isLoadingMore) countEl.textContent = '0';
            window.noMoreSearchPageFilterItems = true;
        }
    } catch (error) {
        console.error('Error applying Old API Douban filters (or Chart API):', error);
        if (!isLoadingMore) resultsDiv.innerHTML = '<p class="col-span-full text-center text-red-500 py-8">加载筛选结果失败。</p>';
    } finally {
        window.isLoadingSearchPageFilters = false;
        if (loadingEl) loadingEl.style.display = 'none';
    }
}


function handleSearchPageScroll() {
    if (window.isLoadingSearchPageFilters || window.noMoreSearchPageFilterItems) {
        return;
    }

    const filterPage = document.getElementById('page-filter');
    if (!filterPage || filterPage.classList.contains('hidden')) {
        return; 
    }

    if ((window.innerHeight + window.scrollY) >= document.body.offsetHeight - 300) {
        console.log("Infinite scroll triggered for Filter Page.");
        applySearchPageFilters(true); 
    }
}
