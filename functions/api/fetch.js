export async function onRequest({ request }) {
  const u = new URL(request.url);
  const target = u.searchParams.get("u");
  const cookiesEnabled = u.searchParams.get("cookies") === "1";

  if (!target) return new Response("Missing ?u=", { status: 400 });

  // Prevent self-fetch loops
  if (target.includes(u.origin)) {
    return new Response("Refusing to fetch own domain", { status: 400 });
  }

  try {
    const resp = await fetch(target, {
      headers: {
        "User-Agent": "Mozilla/5.0 (VirtualBrowser)",
        "Accept": "*/*"
      }
    });

    const contentType = resp.headers.get("content-type") || "";
    const headers = new Headers();
    headers.set("content-type", contentType);

    // If it's HTML → rewrite + inject
    if (contentType.includes("text/html")) {
      let body = await resp.text();

      let injectScript = `
<script>
(function(){
  document.addEventListener('click', function(e){
    var el = e.target;
    while (el && el.nodeType === 1 && el.tagName !== 'A') el = el.parentElement;
    if (el && el.tagName === 'A' && el.href) {
      e.preventDefault();
      parent.postMessage({ type: 'virtualbrowse:navigate', href: el.href }, '*');
    }
  }, true);

  document.addEventListener('DOMContentLoaded', function(){
    try { parent.postMessage({ type: 'virtualbrowse:loaded', href: location.href }, '*'); } catch(e) {}
  });

  ${cookiesEnabled ? `
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

      return new Response(body, { headers });
    } else {
      // Non-HTML → just stream it back (images, JS, CSS, video, etc.)
      return new Response(resp.body, { headers });
    }
  } catch (err) {
    return new Response("Fetch error: " + err.message, { status: 500 });
  }
}
