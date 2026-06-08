(function () {
  if (document.getElementById('top-palms-widget')) return; // prevent double-load

  const script = document.currentScript ||
    document.querySelector('script[src*="embed/chatbot.js"]');
  const api = (script && script.dataset.api)
    ? script.dataset.api.replace(/\/$/, '')
    : '';
  const widgetSrc = api + '/widget';

  // Styles injected into host page
  const style = document.createElement('style');
  style.textContent = `
    #top-palms-fab{position:fixed;bottom:24px;right:24px;width:56px;height:56px;border-radius:50%;background:#006747;color:#fff;border:none;font-size:24px;cursor:pointer;box-shadow:0 4px 16px rgba(0,103,71,.4);z-index:2147483646;display:flex;align-items:center;justify-content:center;transition:transform .15s}
    #top-palms-fab:hover{transform:scale(1.08)}
    #top-palms-greeting{position:fixed;bottom:90px;right:24px;background:#fff;border:1.5px solid #e5e7eb;border-radius:16px 16px 4px 16px;padding:10px 14px;font-size:13px;color:#111827;box-shadow:0 4px 16px rgba(0,0,0,.10);z-index:2147483645;max-width:220px;line-height:1.4;cursor:pointer;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif}
    #top-palms-greeting strong{color:#006747}
    #top-palms-greeting:hover{border-color:#006747}
    #top-palms-panel{position:fixed;bottom:92px;right:24px;width:360px;height:560px;max-width:calc(100vw - 32px);border:none;border-radius:20px;box-shadow:0 8px 40px rgba(0,0,0,.18);z-index:2147483647;display:none;background:#fff;overflow:hidden}
    #top-palms-panel.open{display:block}
  `;
  document.head.appendChild(style);

  // Greeting bubble
  const greeting = document.createElement('div');
  greeting.id = 'top-palms-greeting';
  greeting.innerHTML = '👋 <strong>Hi there!</strong> Looking to make a reservation?';

  // Chat panel (iframe)
  const panel = document.createElement('iframe');
  panel.id = 'top-palms-panel';
  panel.src = widgetSrc;
  panel.title = 'Top of the Palms Reservation';
  panel.setAttribute('allow', 'clipboard-write');

  // FAB button
  const fab = document.createElement('button');
  fab.id = 'top-palms-fab';
  fab.title = 'Make a reservation';
  fab.innerHTML = '🌴';

  function openChat() {
    panel.classList.add('open');
    greeting.style.display = 'none';
  }
  function toggleChat() {
    const isOpen = panel.classList.contains('open');
    if (isOpen) { panel.classList.remove('open'); }
    else { openChat(); }
  }

  fab.onclick = toggleChat;
  greeting.onclick = openChat;

  document.body.appendChild(panel);
  document.body.appendChild(greeting);
  document.body.appendChild(fab);
})();
