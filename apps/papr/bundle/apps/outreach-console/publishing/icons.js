/* global document */
const paths = { home: 'M3 10 12 3l9 7M5 9v12h5v-7h4v7h5V9', calendar: 'M5 4h14a2 2 0 0 1 2 2v14H3V6a2 2 0 0 1 2-2ZM7 2v4M17 2v4M3 10h18', spark: 'm12 3 2.7 6.3L21 12l-6.3 2.7L12 21l-2.7-6.3L3 12l6.3-2.7Z', people: 'M16 21v-3a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v3M16 3a4 4 0 0 1 0 8M22 21v-3a4 4 0 0 0-3-3.8M13 7a4 4 0 1 1-8 0 4 4 0 0 1 8 0', send: 'm22 2-7 20-4-9L2 9ZM22 2 11 13', inbox: 'M3 5h18v14H3ZM3 13h5l2 3h4l2-3h5', chart: 'M4 3v18h17M9 17v-6M14 17V7M19 17V4', settings: 'M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8ZM4 5l3-2 3 2h4l3-2 3 2-1 4 2 3-2 3 1 4-3 2-3-2h-4l-3 2-3-2 1-4-2-3 2-3Z', upload: 'M12 16V3m-5 5 5-5 5 5M4 14v7h16v-7', grid: 'M3 3h7v7H3ZM14 3h7v7h-7ZM3 14h7v7H3ZM14 14h7v7h-7Z', list: 'M8 5h13M8 12h13M8 19h13M3 5h.01M3 12h.01M3 19h.01' };
export function icon(name) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg'); svg.setAttribute('viewBox', '0 0 24 24'); svg.setAttribute('class', 'svg-icon'); svg.setAttribute('aria-hidden', 'true');
  const path = document.createElementNS('http://www.w3.org/2000/svg', 'path'); path.setAttribute('d', paths[name] || paths.grid); svg.append(path); return svg;
}
export function mountIcons(root = document) { root.querySelectorAll('[data-icon]').forEach((node) => node.replaceChildren(icon(node.dataset.icon))); }
