// Client-side: set iframe.src -> server function handles proxying and injection
const address = document.getElementById('address');
const goBtn = document.getElementById('goBtn');
const view = document.getElementById('view');
const status = document.getElementById('status');
const backBtn = document.getElementById('backBtn');
const forwardBtn = document.getElementById('forwardBtn');

let historyStack = [];
let historyIndex = -1;

function setStatus(s) { status.textContent = s; }
function updateNavButtons() {
  backBtn.disabled = historyIndex <= 0;
  forwardBtn.disabled = historyIndex >= historyStack.length - 1;
}

async function loadUrl(target, pushHistory = true) {
  if (!target) return;
  if (!/^https?:\/\//i.test(target)) target = 'https://' + target;
  const endpoint = '/api/fetch?u=' + encodeURIComponent(target);

  setStatus('Loading ' + target + ' ...');
  // navigating the iframe directly (browser will GET /api/fetch?u=...)
  view.src = endpoint;

  // update history - push immediately (we don't wait for iframe loaded message)
  if (pushHistory) {
    historyStack = historyStack.slice(0, historyIndex + 1);
    historyStack.push(target);
    historyIndex = historyStack.length - 1;
    updateNavButtons();
  }
}

goBtn.addEventListener('click', () => {
  loadUrl(address.value, true);
});
address.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') goBtn.click();
});

backBtn.addEventListener('click', () => {
  if (historyIndex > 0) {
    historyIndex -= 1;
    loadUrl(historyStack[historyIndex], false);
    updateNavButtons();
  }
});
forwardBtn.addEventListener('click', () => {
  if (historyIndex < historyStack.length - 1) {
    historyIndex += 1;
    loadUrl(historyStack[historyIndex], false);
    updateNavButtons();
  }
});

// listen for messages from the iframe-injected script
window.addEventListener('message', (ev) => {
  const msg = ev.data || {};
  if (msg.type === 'virtualbrowse:navigate' && msg.href) {
    // user clicked a link inside the iframe: navigate via proxy
    loadUrl(msg.href, true);
  } else if (msg.type === 'virtualbrowse:loaded' && msg.href) {
    // iframe content reports its resolved URL (update address bar)
    address.value = msg.href;
    setStatus('Loaded: ' + msg.href);
  }
});

// when iframe navigates (load event), try to set status if no message arrived
view.addEventListener('load', () => {
  setStatus('Frame loaded');
});

setStatus('Ready');
updateNavButtons();
