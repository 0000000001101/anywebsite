// functions/api/fetch.js
// Cloudflare Pages Function (Workers runtime)
// Proxies any resource at ?u=<url>
// - For HTML: rewrites relative links (src, href, srcset, CSS url()) to go back through /api/fetch
// - Injects <base> and a small navigation script to postMessage parent on clicks
// - Removes Content-Security-Policy, X-Frame-Options, and frame-ancestors headers
// - Streams binary resources unchanged

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

    // Normalize and ensure scheme
    let normalized = target.trim();
    if (!/^https?:\/\//i.test(normalized)) normalized = 'https://' + normalized;
    const targetUrl = new URL(normalized);

    // Prevent obvious local/private targets
    const host = targetUrl.hostname;
    const privateIpRegex = /^(127\.|10\.|192\.168\.|172\.(1[6-9]|2[0-9]|3[0-1])\.)/;
    if (host === 'localhost' || host === '::1' || privateIpRegex.test(host)) {
      return new Response(JSON.stringify({ ok: false, error: 'Blocked local/private host' }), { status: 403, headers: { 'content-type': 'application/json' }});
    }

    // Fetch the target resource
    const fetched = await fetch(targetUrl.toString(), {
      redirect: 'follow',
      headers: {
        // present like a browser to reduce bot blocking
        'User-Agent': 'Mozilla/5.0 (VirtualBrowser)'
      }
    });

    const contentType = (fetched.headers.get('content-type') || 'application/octet-stream').toLowerCase();

    // Build response headers: carry content-type but strip problematic security headers
    const outHeaders = new Headers();
    outHeaders.set('content-type', contentType);

    // Allow the iframe to fetch subresources from our origin (helps CORS in some cases)
    outHeaders.set('x-proxied-by', 'cloudflare-pages-virtual-browser');

    // If content is HTML, rewrite and inject
    if (contentType.includes('text/html')) {
      let html = await fetched.text();

      // Remove meta CSP tags that could block script execution
      html = html.replace(/<meta[^>]*http-equiv\s*=\s*["']?content-security-policy["']?[^>]*>/gi, '');

      // Remove <meta http-equiv="X-Frame-Options"> or similar
      html = html.replace(/<meta[^>]*http-equiv\s*=\s*["']?x-frame-options["']?[^>]*>/gi, '');

      // Inject <base href="..."> into <head> so relative URLs resolve correctly
      const baseTag = `<base href="${escapeHtml(targetUrl.origin + targetUrl.pathname)}">`;
      if (/<head[^>]*>/i.test(html)) {
        html = html.replace(/<head([^>]*)>/i, `<head$1>\n${baseTag}\n`);
      } else {
        html = baseTag + '\n' + html;
      }

      // Rewrite src and href attributes that are relative to route them through the proxy
      // Handles src/href not starting with http or data:
      html = html.replace(/(?:src|href)\s*=\s*(['"])(?!https?:|data:|\/\/)([^'"]+)\1/gi,
        (m, q, rel) => {
          try {
            const abs = new URL(rel, targetUrl).href;
            return m.replace(rel, `/api/fetch?u=${encodeURIComponent(abs)}`);
          } catch (e) {
            return m;
          }
        });

      // Rewrite protocol-relative URLs //example.com -> keep absolute and proxy
      html = html.replace(/(?:src|href)\s*=\s*(['"])(\/\/[^'"]+)\1/gi,
        (m, q, rel) => {
          const abs = (targetUrl.protocol || 'https:') + rel;
          return m.replace(rel, `/api/fetch?u=${encodeURIComponent(abs)}`);
        });

      // Rewrite srcset attributes (multiple URLs)
      html = html.replace(/srcset\s*=\s*(['"])([^'"]+)\1/gi, (m, q, val) => {
        const parts = val.split(',').map(p => p.trim()).map(item => {
          // each item can be "url [descriptor]"
          const [u, desc] = item.split(/\s+/, 2);
          if (/^https?:|^data:|^\/\//i.test(u)) return item.includes(' ') ? item : u;
          try {
            const abs = new URL(u, targetUrl).href;
            return `/api/fetch?u=${encodeURIComponent(abs)}` + (desc ? ' ' + desc : '');
          } catch (e) {
            return item;
          }
        });
        return `srcset="${parts.join(', ')}"`;
      });

      // Rewrite CSS url(...) occurrences (simple heuristic)
      html = html.replace(/url\((?!['"]?https?:|['"]?data:|['"]?\/\/)(['"]?)([^'")]+)\1\)/gi, (m, q, rel) => {
        try {
          const abs = new URL(rel, targetUrl).href;
          return `url("/api/fetch?u=${encodeURIComponent(abs)}")`;
        } catch (e) {
          return m;
        }
      });

      // Preserve YouTube iframe embeds (do not rewrite their src)
      // (we left absolute iframe src intact above for https:cases)

      // Inject a small script to forward link clicks to the parent window
      const navScript = `
<script>
  (function(){
    // capture clicks on links and post to parent to let it manage navigation
    document.addEventListener('click', function(e){
      var el = e.target;
      while (el && el.nodeType === 1 && el.tagName !== 'A') el = el.parentElement;
      if (el && el.tagName === 'A' && el.href) {
        e.preventDefault();
        parent.postMessage({ type: 'virtualbrowse:navigate', href: el.href }, '*');
      }
    }, true);

    // notify parent of the current location when DOMContentLoaded
    document.addEventListener('DOMContentLoaded', function(){
      try { parent.postMessage({ type: 'virtualbrowse:loaded', href: location.href }, '*'); } catch(e) {}
    });
  })();
</script>`.trim();

      // Insert nav script before </body>
      if (/<\/body>/i.test(html)) {
        html = html.replace(/<\/body>/i, `${navScript}\n</body>`);
      } else {
        html = html + navScript;
      }

      outHeaders.set('content-type', 'text/html; charset=utf-8');
      // Return the rewritten HTML
      return new Response(html, { headers: outHeaders });
    }

    // Non-HTML: stream binary/text unchanged, but strip CSP/XFO headers by not forwarding them
    const buf = await fetched.arrayBuffer();
    // copy relevant headers
    const ct = fetched.headers.get('content-type');
    if (ct) outHeaders.set('content-type', ct);
    // Cache control passthrough (optional)
    const cache = fetched.headers.get('cache-control');
    if (cache) outHeaders.set('cache-control', cache);
    // Return binary
    return new Response(buf, { headers: outHeaders });
  } catch (err) {
    return new Response(JSON.stringify({ ok: false, error: String(err && err.message ? err.message : err) }), {
      status: 500,
      headers: { 'content-type': 'application/json' }
    });
  }
}

// small helper for safe attribute injection
function escapeHtml(s='') {
  return String(s).replace(/[&<>"']/g, function(ch) {
    return ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;', "'":'&#39;' })[ch];
  });
}
