// ... same code as before ...

      // Inject a small script to forward link clicks + remove cookie popups
      const navAndCookieScript = `
<script>
  (function(){
    // Navigation: intercept clicks on links
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

    // --- Cookie popup remover ---
    function removeCookiePopups(){
      const selectors = [
        '[id*="cookie"]',
        '[class*="cookie"]',
        '[id*="consent"]',
        '[class*="consent"]',
        'div[role="dialog"]'
      ];
      for (const sel of selectors) {
        document.querySelectorAll(sel).forEach(el=>{
          // try auto-click buttons inside first
          const btn = el.querySelector('button, input[type="button"], input[type="submit"]');
          if (btn) btn.click();
          // then hide the element
          el.style.display = 'none';
        });
      }
    }
    removeCookiePopups();

    // Keep watching for new popups
    const obs = new MutationObserver(removeCookiePopups);
    obs.observe(document.body, { childList: true, subtree: true });
  })();
</script>`.trim();

      // Insert script before </body>
      if (/<\/body>/i.test(html)) {
        html = html.replace(/<\/body>/i, `${navAndCookieScript}\n</body>`);
      } else {
        html = html + navAndCookieScript;
      }

// ... rest of code unchanged ...
