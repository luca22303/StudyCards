// Markdown rendering for card sides.

import { marked } from '../vendor/marked.esm.js';
import DOMPurify from '../vendor/purify.es.js';
import { imageUrl } from './images.js';

marked.setOptions({ gfm: true, breaks: true });

// Card images are written as ![](img:<id>). DOMPurify strips unknown URL
// schemes, so the id is moved to a data attribute before sanitizing and
// resolved to a blob URL afterwards.
export function renderMarkdown(el, text) {
  const html = marked.parse(text ?? '').replace(/src="img:([\w.-]+)"/g, 'data-img="$1"');
  el.innerHTML = DOMPurify.sanitize(html, { ADD_ATTR: ['data-img'] });
  for (const img of el.querySelectorAll('img[data-img]')) {
    img.alt ||= 'Card image';
    img.classList.add('loading');
    imageUrl(img.dataset.img).then(url => {
      img.classList.remove('loading');
      if (url) img.src = url;
      else img.replaceWith(Object.assign(document.createElement('span'), {
        className: 'img-missing',
        textContent: 'Image not available offline yet',
      }));
    });
  }
  // Links in cards open outside the app, so a tap never loses the session.
  for (const a of el.querySelectorAll('a[href]')) {
    a.target = '_blank';
    a.rel = 'noopener';
  }
}
