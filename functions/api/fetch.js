export async function onRequest({ request }) {
  const u = new URL(request.url);
  const target = u.searchParams.get("u");
  const cookiesEnabled = u.searchParams.get("cookies") === "1";

  if (!target) return new Response("Missing ?u=", { status: 400 });

  try {
    const resp = await fetch(target, {
      headers: { "User-Agent": "Mozilla/5.0 (VirtualBrowser)" }
    });

    let contentType = resp.headers.get("content-type") || "text/html";
    let body = await resp.text();

    const headers = new Headers();
    headers.set("content-type", contentType);

    if (contentType.includes("text/html")) {
      // Inject navigation + optional cookie popup remover
      let injectScript = `
<script>
(function(){
  // Navigation: forward link clicks
  document.addEventListener('click', function(e){
    var el = e.target;
    while (el && el.nodeType === 1 && el.tagName !== 'A') el = el.parentElement;
    if (el && el.tagName === 'A' && el.href) {
      e.preventDefault();
      parent.postMessage({ type: 'virtualbrowse:navigate', href: el.href }, '*');
    }
  }, true);

  // Notify parent when loaded
  document.addEventListener('DOMContentLoaded', function(){
    try { parent.postMessage({ type: 'virtualbrowse:loaded', href: location.href }, '*'); } catch(e) {}
  });

  ${cookiesEnabled ? `
  // --- Cookie popup remover ---
  function removeCookiePopups(){
    const selectors = [
      '[id*="cookie"]','[class*="cookie"]',
      '[id*="consent"]','[class*="consent"]',
      'div[role="dialog"]'
    ];
    for (const sel of selectors) {
      document.querySelectorAll(sel).forEach(el=>{
        const btn = el.querySelector('button, input[type="button"], input[type="submit"]');
        if (btn) btn.click();
        el.style.display = 'none';
      });
    }
  }
  removeCookiePopups();
  const obs = new MutationObserver(removeCookiePopups);
  obs.observe(document.body, { childList: true, subtree: true });
  ` : ""}
})();</script>`;

      if (/<\/body>/i.test(body)) {
        body = body.replace(/<\/body>/i, injectScript + "</body>");
      } else {
        body += injectScript;
      }
    }

    return new Response(body, { headers });
  } catch (err) {
    return new Response("Fetch error: " + err.message, { status: 500 });
  }
}
