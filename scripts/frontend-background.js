// Free endpoint documentation: https://xxapi.cn/doc/randomAcgPic
addEventListener('DOMContentLoaded', () => {
  const image = document.createElement('img');
  image.id = 'catsuki-background';
  image.alt = '';
  image.setAttribute('aria-hidden', 'true');
  image.referrerPolicy = 'no-referrer';
  image.decoding = 'async';
  image.onload = () => { image.classList.add('loaded'); };
  image.onerror = () => image.remove();
  const type = matchMedia('(max-width: 640px)').matches ? 'wap' : 'pc';
  image.src = `https://v2.xxapi.cn/api/randomAcgPic?type=${type}&return=302&t=${Date.now()}`;
  document.body.prepend(image);
});
