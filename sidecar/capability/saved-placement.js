'use strict';
const { makeStationStore } = require('../station-store.js');
// The saved floor as a station model, validated through the same path the router's station store uses; null
// when there is none or it does not validate. Shared with cap-scope.js so a run that needs both reads validates once.
function checkedStation(save) {
  if (!save || !save.station) return null;
  const checked = makeStationStore().validateStationDoc(save.station);
  return checked.ok ? checked.station : null;
}
// The same room scope World.heroCaps uses. A missing client snapshot may use the
// durable floor; an explicitly empty snapshot must never resurrect removed gear.
function savedPlacement(save, agentId) {
  const station = checkedStation(save);
  if (!station) return [];
  const scoped = !!station.agentRoomId(agentId);
  const types = scoped
    ? station.bayObjects(agentId)
    : station.props().map(p => station.capForProp(p.t));
  const out = [...new Set(types.map(o => typeof o === 'string' ? o : o && o.objectType)
    .filter(t => t && t !== 'computer' && t !== 'connector' && t !== 'plugin'))]
    .map(objectType => ({ objectType }));
  // PLUGIN TERMINALS are per-instance like connector portals, but projected from the placement (their binding
  // names WHICH plugin): keep each bound terminal in scope as { objectType: 'plugin', pluginId }, once per plugin.
  const plugins = scoped
    ? station.bayObjects(agentId).filter(o => o && typeof o === 'object' && o.objectType === 'plugin' && o.pluginId).map(o => o.pluginId)
    : station.props().filter(p => p.t === 'plugin_terminal' && p.pluginId).map(p => p.pluginId);
  for (const pluginId of new Set(plugins)) out.push({ objectType: 'plugin', pluginId });
  return out;
}
module.exports = { savedPlacement, checkedStation };
