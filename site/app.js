// Minimal client-side router for ordinary.click.
// Routes:
//   /                       -> intro + category grid
//   /c/<category>           -> images in a category

const app = document.getElementById("app");

async function fetchJSON(path) {
  const res = await fetch(path, { headers: { accept: "application/json" } });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
  return res.json();
}

function render(html) {
  app.innerHTML = html;
}

async function renderHome() {
  render(`<section id="intro"><p>Loading categories…</p></section>`);
  try {
    const { categories } = await fetchJSON("/api/categories");
    if (!categories.length) {
      render(`<section><p>No categories yet. Upload images under <code>categories/&lt;name&gt;/</code> in S3.</p></section>`);
      return;
    }
    const cards = categories.map(c => `
      <a class="category-card" href="#/c/${encodeURIComponent(c.name)}">
        ${c.cover ? `<img loading="lazy" src="${c.cover}" alt="${c.name}">` : ""}
        <span class="label"><strong>${c.name}</strong><span>${c.count}</span></span>
      </a>
    `).join("");
    render(`
      <section><p>Pick a category below.</p></section>
      <section class="categories">${cards}</section>
    `);
  } catch (err) {
    render(`<section><p>Couldn't load categories: ${err.message}</p></section>`);
  }
}

async function renderCategory(name) {
  render(`<section><a class="back" href="#/">← all categories</a><h2>${name}</h2><p>Loading…</p></section>`);
  try {
    const data = await fetchJSON(`/api/categories/${encodeURIComponent(name)}`);
    const imgs = data.images.map(i => `<img loading="lazy" src="${i.url}" alt="">`).join("");
    render(`
      <section><a class="back" href="#/">← all categories</a><h2>${name}</h2></section>
      <section class="gallery">${imgs}</section>
    `);
  } catch (err) {
    render(`<section><a class="back" href="#/">← all categories</a><p>Couldn't load category: ${err.message}</p></section>`);
  }
}

function route() {
  const hash = location.hash.replace(/^#/, "") || "/";
  const m = hash.match(/^\/c\/(.+)$/);
  if (m) return renderCategory(decodeURIComponent(m[1]));
  return renderHome();
}

window.addEventListener("hashchange", route);
route();
