// This file now only initializes the Douban related functionalities.
// All core logic, UI, and API functions have been moved to:
// - douban_logic.js
// - douban_ui.js
// - douban_api.js
// - douban_filters.js

// Ensure that douban_logic.js (which contains initDouban) is loaded before this script.
// The order in index.html should be: douban_api, douban_ui, douban_logic, douban_filters, then douban.js.

if (typeof initDouban === 'function') {
    // Pass initial state if available, e.g., from a global config or specific needs.
    // For now, calling without arguments, initDouban will check sessionStorage.
    initDouban(); 
} else {
    console.error('Failed to initialize Douban features: initDouban function not found. Check script load order.');
}
