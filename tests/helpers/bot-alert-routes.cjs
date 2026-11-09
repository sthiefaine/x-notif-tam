const { loadTypeScript } = require("./load-typescript.cjs");
const realtime = loadTypeScript("lib/transit/realtime.ts");
const stopMatching = loadTypeScript("lib/transit/stop-matching.ts");
const dwell = loadTypeScript("lib/transit/dwell.ts", { mocks: { "./realtime": realtime, "./stop-matching": stopMatching } });
const liveAlerts = loadTypeScript("lib/transit/live-alerts.ts", { mocks: { "./realtime": realtime, "./dwell": dwell, "./alert-impacts": loadTypeScript("lib/transit/alert-impacts.ts") } });
function loadBotAlertRoutes({ routeIds = ["1", "2", "3", "4", "5", "12", "33", "A", "Amigo"], unavailable = false } = {}) {
  return loadTypeScript("app/api/post_tweets/alertRoutes.ts", {
    mocks: {
      "@/lib/transit/live-alerts": liveAlerts,
      "@/lib/transit/network": { getTransitNetwork: async () => {
        if (unavailable) throw new Error("fake missing static data");
        return { routes: routeIds.map((id) => ({ id })) };
      } },
    },
  });
}
module.exports = { loadBotAlertRoutes };
