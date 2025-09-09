// functions/api/fetch.js
export async function onRequest({ request }) {
  try {
    const reqUrl = new URL(request.url);
    const target = reqUrl.searchParams.get('u');
    if (!target) {
      return new Response(JSON.stringify({ ok: false, error: "Missing 'u' parameter" }), {
        status: 400,
        headers: { 'content-type': 'application/json' }
      });
    }

    // Normalize target URL
    let normalized = target.trim();
    if (!/^https?:\/\//i.test(normalized)) normalized = 'https://' + normalized;
    let targetUrl = new URL(normalized);

    // --- Special case: YouTube watch -> embed ---
    if (targetUrl.hostname.includes('youtube.com') && targetUrl.pathname === '/watch') {
      const vid = targetUrl.searchParams.get('v');
      if (vid) {
        normalized = `https://www.youtube.com/embed/${vid}`;
        targetUrl = new URL(normalized);
      }
    }

    // Block obvious local/private targets
    const host = targetUrl.hostname;
    const privateIpRegex = /^(127\.|10\.|192\.168\.|172\.(1[6-9]|2[0-9]|3[0-1])\.)/;
    if (host === 'localhost' || host === '::1' || privateIpRegex.test(host)) {
      return new Response(JSON.stringify({ ok: false, error: 'Blocked local/private host' }), { status: 403, headers: { 'content-type': 'application/json' }});
    }

    // Fetch the resource
    const fetched = await fetch(targetUrl.toString(), {
      redirect: 'follow',
      headers: { 'User-Agent': 'Mozilla/5.0 (VirtualBrowser)' }
    });

    const rawContentType = fetched.headers.get('content-type') || 'application/octet-stream';
    const contentType = rawContentType.split(';')[0].toLowerCase();

    const outHeaders = new Headers();
    outHeaders.set('x-proxied-by', 'cloudflare-pages-virtual-browser');
    if (fetched.headers.get('cache-control')) outHeaders.set('cache-control', fetched.headers.get('cache-control'));
    if (fetched.headers.get('expires')) outHeaders.set('expires', fetched.headers.get('expires'));

    // --- If HTML -> rewrite & inject ---
    if (contentType === 'text/html') {
      let html = await fetched.text();

      // Remove CSP/Frame-blocking meta tags
      html = html.replace(/<meta[^>]*http-equiv\s*=\s*["']?content-security-policy["']?[^>]*>/gi, '');
      html = html.replace(/<meta[^>]*http-equiv\s*=\s*["']?x-frame-options["']?[^>]*>/gi, '');

      // Add <base> to fix relative URLs
      const baseHref = escapeHtml(targetUrl.origin + targetUrl.pathname.replace(/\/[^/]*$/, '/') );
      const baseTag = `<base href="${baseHref}">`;
      if (/<head[^>]*>/i.test(html)) {
        html = html.replace(/<head([^>]*)>/i, `<head$1>\n${baseTag}\n`);
      } else {
        html = baseTag + '\n' + html;
      }

      // Rewrite relative URLs for src/href/srcset/css url(...)
      html = rewriteRelativeUrls(html, targetUrl);

      // Inject navigation + cookie remover script
      html = injectHelperScript(html, targetUrl);

      outHeaders.set('content-type', 'text/html; charset=utf-8');
      return new Response(html, { headers: outHeaders });
    }

    // --- Non-HTML resources ---
    const buffer = await fetched.arrayBuffer();
    if (rawContentType) outHeaders.set('content-type', rawContentType);
    return new Response(buffer, { headers: outHeaders });

  } catch (err) {
    return new Response(JSON.stringify({ ok: false, error: String(err && err.message ? err.message : err) }), {
      status: 500,
      headers: { 'content-type': 'application/json' }
    });
  }
}

// --- Helper: escape HTML ---
function escapeHtml(s='') {
  return String(s).replace(/[&<>"']/g, ch => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;', "'":'&#39;' }[ch]));
}

// --- Helper: rewrite URLs ---
function rewriteRelativeUrls(html, baseUrl) {
  // src/href (skip absolute, data:, etc.)
  html = html.replace(/(?:\b(src|href))\s*=\s*(['"])(?!https?:|\/\/|data:|mailto:|tel:|javascript:)([^'"]+)\2/gi,
    (m, attr, q, rel) => `${attr}=${q}/api/fetch?u=${encodeURIComponent(new URL(rel, baseUrl).href)}${q}`);
  // protocol-relative (//example.com)
  html = html.replace(/(?:\b(src|href))\s*=\s*(['"])(\/\/[^'"]+)\2/gi,
    (m, attr, q, rel) => `${attr}=${q}/api/fetch?u=${encodeURIComponent(baseUrl.protocol + rel)}${q}`);
  // srcset
  html = html.replace(/\bsrcset\s*=\s*(['"])([^'"]+)\1/gi, (m, q, val) => {
    const parts = val.split(',').map(p => p.trim()).map(item => {
      const [u, desc] = item.split(/\s+/, 2);
      if (/^(https?:|\/\/|data:|mailto:|tel:)/i.test(u)) return item;
      const abs = new URL(u, baseUrl).href;
      return `/api/fetch?u=${encodeURIComponent(abs)}` + (desc ? ' ' + desc : '');
    });
    return `srcset=${q}${parts.join(', ')}${q}`;
  });
  // CSS url(...)
  html = html.replace(/url\(\s*(['"]?)(?!https?:|\/\/|data:|blob:)([^'")]+)\1\s*\)/gi,
    (m, q, rel) => `url("/api/fetch?u=${encodeURIComponent(new URL(rel, baseUrl).href)}")`);
  return html;
}

// --- Helper: inject script ---
function injectHelperScript(html, targetUrl) {
  const script = `
<script>
(function(){
  function safe(fn){try{fn();}catch(e){}}

  function setup(){
    // link interception
    document.addEventListener('click', function(e){
      var el = e.target;
      while (el && el.nodeType===1 && el.tagName!=='A') el=el.parentElement;
      if(el && el.tagName==='A' && el.href){
        e.preventDefault();
        parent.postMessage({ type:'virtualbrowse:navigate', href:el.href }, '*');
      }
    }, true);

    // notify parent
    safe(()=>parent.postMessage({ type:'virtualbrowse:loaded', href:location.href }, '*'));

    // cookie popup remover
    function remove(){
      var sels=['[id*="cookie"]','[class*="cookie"]','[id*="consent"]','[class*="consent"]','[id*="gdpr"]','[class*="gdpr"]','[role="dialog"]'];
      sels.forEach(sel=>{
        document.querySelectorAll(sel).forEach(el=>{
          safe(()=>{(el.querySelector('button,a,[role="button"],input[type="button"],input[type="submit"]')||{}).click?.();});
          el.style.display='none';
        });
      });
    }
    remove();
    new MutationObserver(remove).observe(document.body||document.documentElement,{childList:true,subtree:true});
  }
  if(document.readyState==='loading') document.addEventListener('DOMContentLoaded',setup);
  else setup();
})();
</script>`;
  if (/<\/body>/i.test(html)) return html.replace(/<\/body>/i, script + '\n</body>');
  return html + script;
}
