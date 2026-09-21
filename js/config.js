const RELAY = '';

const override = new URLSearchParams(location.search).get('relay');
const base = (override || RELAY).trim().replace(/\/+$/, '');

export const PRESENCE_BASE = base;
export const endpoint = (path) => (base ? `${base}/${path}` : path);
