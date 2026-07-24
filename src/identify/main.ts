/**
 * "Which display is this?" overlay (spec §52.4).
 *
 * One of these runs in a tiny, always-on-top, click-through window centred on
 * each connected display for ~2.5 s. Rust owns the numbering; this page only
 * renders the number it was handed in the query string. Deliberately free of
 * app imports so it costs nothing and cannot fail for app-state reasons.
 */
const params = new URLSearchParams(window.location.search);
const rawNumber = Number(params.get('n'));
const displayNumber = Number.isFinite(rawNumber) && rawNumber > 0 ? String(rawNumber) : '?';
const isPrimary = params.get('primary') === '1';

const root = document.getElementById('identify');

if (root) {
  root.className = 'identify';

  const numberEl = document.createElement('div');
  numberEl.className = 'number';
  numberEl.textContent = displayNumber;
  root.appendChild(numberEl);

  const labelEl = document.createElement('div');
  labelEl.className = 'label';
  labelEl.textContent = isPrimary ? 'Display · Primary' : 'Display';
  root.appendChild(labelEl);
}

const style = document.createElement('style');
style.textContent = `
  html, body {
    margin: 0;
    height: 100%;
    overflow: hidden;
    background: #0d0f12;
    color: #ffffff;
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif;
    user-select: none;
    cursor: none;
  }
  .identify {
    height: 100%;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 6px;
    box-shadow: inset 0 0 0 2px rgba(255, 255, 255, 0.14);
  }
  .number {
    font-size: 132px;
    font-weight: 650;
    line-height: 1;
    letter-spacing: -0.03em;
  }
  .label {
    font-size: 15px;
    font-weight: 500;
    letter-spacing: 0.04em;
    text-transform: uppercase;
    opacity: 0.68;
  }
`;
document.head.appendChild(style);
