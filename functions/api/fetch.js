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
    const targetUrl = new URL(normalized);

    // Block obvious local/private targets
    const host = targetUrl.hostname;
    const privateIpRegex = /^(127\.|10\.|192\.168\.|172\.(1[6-9]|2[0-9]|3[0-1])\.)/;
    if (host === 'localhost' || host === '::1' || privateIpRegex.test(host)) {
      return new Response(JSON.stringify({ ok: false, error: 'Blocked local/private host' }), { status: 403, headers: { 'content-type': 'application/json' }});
    }

    // Fetch the resource
    const fetched = await fetch(targetUrl.toString(), {
      redirect: 'follow',
      headers: {
        'User-Agent': 'Mozilla/5.0 (VirtualBrowser)'
      }
    });

    const rawContentType = fetched.headers.get('content-type') || 'application/octet-stream';
    const contentType = rawContentType.split(';')[0].toLowerCase();

    // Build response headers; intentionally do not forward CSP/XFO/frame-ancestors
    const outHeaders = new Headers();
    outHeaders.set('x-proxied-by', 'cloudflare-pages-virtual-browser');
    if (fetched.headers.get('cache-control')) outHeaders.set('cache-control', fetched.headers.get('cache-control'));
    if (fetched.headers.get('expires')) outHeaders.set('expires', fetched.headers.get('expires'));

    // If HTML -> rewrite / inject safely
    if (contentType === 'text/html') {
      let html = await fetched.text();

      // Remove meta CSP tags that could block script execution
      html = html.replace(/<meta[^>]*http-equiv\s*=\s*["']?content-security-policy["']?[^>]*>/gi, '');
      // Remove meta X-Frame-Options too
      html = html.replace(/<meta[^>]*http-equiv\s*=\s*["']?x-frame-options["']?[^>]*>/gi, '');
      // Remove server CSP header by ignoring it (we don't forward it)

      // Insert <base> to help resolve relative URLs (use origin + pathname as base)
      const baseHref = escapeHtml(targetUrl.origin + targetUrl.pathname.replace(/\/[^/]*$/, '/') );
      const baseTag = `<base href="${baseHref}">`;
      if (/<head[^>]*>/i.test(html)) {
        html = html.replace(/<head([^>]*)>/i, `<head$1>\n${baseTag}\n`);
      } else {
        html = baseTag + '\n' + html;
      }

      // Safe rewriting helpers:
      // - only rewrite relative URLs (not ones starting with http(s):, data:, mailto:, tel:, javascript:, //)
      // - handle src, href, srcset, and CSS url(...)
      // - do not rewrite YouTube iframe src (keep absolute YouTube iframe srcs unchanged)

      // 1) Rewrite src and href attributes that are relative
      html = html.replace(/(?:\b(src|href))\s*=\s*(['"])(?!\s*https?:|\/\/|data:|mailto:|tel:|javascript:)([^'"]+)\2/gi,
        (m, attr, quote, rel) => {
          try {
            const abs = new URL(rel, targetUrl).href;
            return `${attr}=${quote}/api/fetch?u=${encodeURIComponent(abs)}${quote}`;
          } catch (e) {
            return m;
          }
        });

      // 2) Protocol-relative URLs (//example.com) -> proxy absolute
      html = html.replace(/(?:\b(src|href))\s*=\s*(['"])(\/\/[^'"]+)\2/gi,
        (m, attr, quote, rel) => {
          const abs = (targetUrl.protocol || 'https:') + rel;
          return `${attr}=${quote}/api/fetch?u=${encodeURIComponent(abs)}${quote}`;
        });

      // 3) srcset attributes
      html = html.replace(/\bsrcset\s*=\s*(['"])([^'"]+)\1/gi, (m, q, val) => {
        try {
          const parts = val.split(',').map(p => p.trim()).map(item => {
            const [u, desc] = item.split(/\s+/, 2);
            if (/^(https?:|\/\/|data:|mailto:|tel:)/i.test(u)) return item;
            const abs = new URL(u, targetUrl).href;
            return `/api/fetch?u=${encodeURIComponent(abs)}` + (desc ? ' ' + desc : '');
          });
          return `srcset=${q}${parts.join(', ')}${q}`;
        } catch (e) {
          return m;
        }
      });

      // 4) CSS url(...) rewriting (skip data:, blob:, http(s):, //)
      html = html.replace(/url\(\s*(['"]?)(?!\s*https?:|\/\/|data:|blob:)([^'")]+)\1\s*\)/gi, (m, q, rel) => {
        try {
          const abs = new URL(rel, targetUrl).href;
          return `url("/api/fetch?u=${encodeURIComponent(abs)}")`;
        } catch (e) {
          return m;
        }
      });

      // 5) Don't touch absolute iframe srcs for well-known embed providers (YouTube, Vimeo)
      // (we already rewrite relative/protocol-relative iframe srcs above; absolute YouTube iframe srcs remain untouched)

      // 6) Inject safe nav + cookie script (robust: wait for DOMContentLoaded, try/catch, no direct errors)
      const injectedScript = `
<script>
(function(){
  function trySafe(fn){ try{ fn(); } catch(e){ /* swallow */ } }

  function install() {
    trySafe(function(){
      // navigation: capture clicks on links and message parent
      document.addEventListener('click', function(e){
        try{
          var el = e.target;
          while (el && el.nodeType === 1 && el.tagName !== 'A') el = el.parentElement;
          if (el && el.tagName === 'A' && el.href) {
            e.preventDefault();
            // send absolute href to parent
            parent.postMessage({ type: 'virtualbrowse:navigate', href: el.href }, '*');
          }
        }catch(err){}
      }, true);

      // notify parent when the page has loaded
      try { parent.postMessage({ type: 'virtualbrowse:loaded', href: location.href }, '*'); } catch(e) {}

      // cookie/banner remover - safe, heuristic-based
      function removeBannersOnce(){
        trySafe(function(){
          var selectors = [
            '[id*=\"cookie\"]',
            '[class*=\"cookie\"]',
            '[id*=\"consent\"]',
            '[class*=\"consent\"]',
            '[id*=\"gdpr\"]',
            '[class*=\"gdpr\"]',
            '[role=\"dialog\"]'
          ];
          selectors.forEach(function(sel){
            document.querySelectorAll(sel).forEach(function(el){
              trySafe(function(){
                // attempt to click obvious accept buttons first
                var clickable = el.querySelector('button, input[type=\"button\"], input[type=\"submit\"], a');
                if (clickable) trySafe(function(){ clickable.click(); });
                // hide the element as a fallback
                el.style.setProperty('display','none','important');
                el.setAttribute('data-proxied-removed','1');
              });
            });
          });
        });
      }

      // run immediately and then observe
      trySafe(removeBannersOnce);
      var obs = new MutationObserver(function(mutations){
        trySafe(removeBannersOnce);
      });
      try {
        if (document.body) obs.observe(document.body, { childList: true, subtree: true });
        else {
          // if body not yet present, wait for DOMContentLoaded
          document.addEventListener('DOMContentLoaded', function(){
            trySafe(removeBannersOnce);
            trySafe(function(){ obs.observe(document.body, { childList: true, subtree: true }); });
          });
        }
      } catch(e){ /* ignore */ }
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', install);
  } else {
    install();
  }
})();
</script>`.trim();

      // Insert before </body>, else append to the end
      if (/<\/body>/i.test(html)) {
        html = html.replace(/<\/body>/i, `${injectedScript}\n</body>`);
      } else {
        html = html + injectedScript;
      }

      outHeaders.set('content-type', 'text/html; charset=utf-8');
      return new Response(html, { headers: outHeaders });
    }

    // Non-HTML: return as binary/text and set content-type
    const buffer = await fetched.arrayBuffer();
    const ct = fetched.headers.get('content-type');
    if (ct) outHeaders.set('content-type', ct);
    return new Response(buffer, { headers: outHeaders });
  } catch (err) {
    return new Response(JSON.stringify({ ok: false, error: String(err && err.message ? err.message : err) }), {
      status: 500,
      headers: { 'content-type': 'application/json' }
    });
  }
}

// HTML-escape helper
function escapeHtml(s='') {
  return String(s).replace(/[&<>"']/g, function(ch){
    return ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;', "'":'&#39;' })[ch];
  });
}
