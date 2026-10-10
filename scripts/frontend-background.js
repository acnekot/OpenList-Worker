// Free endpoint documentation: https://xxapi.cn/doc/randomAcgPic
addEventListener('DOMContentLoaded', () => {
  const image = document.createElement('img');
  image.id = 'catsuki-background';
  image.alt = '';
  image.setAttribute('aria-hidden', 'true');
  image.referrerPolicy = 'no-referrer';
  image.decoding = 'async';
  // Keep the same picture for the whole tab session instead of swapping on every refresh.
  const type = matchMedia('(max-width: 640px)').matches ? 'wap' : 'pc';
  const key = `catsuki-bg-${type}`;
  let saved = null;
  try { saved = sessionStorage.getItem(key); } catch {}
  image.onload = () => {
    image.classList.add('loaded');
    try { if (!saved && image.currentSrc) sessionStorage.setItem(key, image.currentSrc); } catch {}
  };
  image.onerror = () => {
    if (saved) { // stale cached link: fall back to a fresh random picture once
      try { sessionStorage.removeItem(key); } catch {}
      saved = null;
      image.src = `https://v2.xxapi.cn/api/randomAcgPic?type=${type}&return=302&t=${Date.now()}`;
    } else image.remove();
  };
  image.src = saved || `https://v2.xxapi.cn/api/randomAcgPic?type=${type}&return=302&t=${Date.now()}`;
  document.body.prepend(image);
});
