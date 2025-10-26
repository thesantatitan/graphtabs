# GraphTabs Manual Test Checklist

Follow these steps to validate the v1 experience described in the project brief:

1. **Seed windows and tabs**
   - Open 3–5 normal sites in a single window.
   - Middle-click a few links so their `openerTabId` is populated.
   - Open a second browser window with several more tabs.
2. **Launch GraphTabs**
   - Click the GraphTabs toolbar icon and ensure the graph canvas loads without errors.
3. **Graph accuracy**
   - Confirm every open tab appears as a node and that windows are grouped into separate columns.
   - Verify edges connect opener tabs to the tabs they spawned.
4. **Thumbnail capture**
   - Ensure the active tab in each window receives a thumbnail within ~1 second.
   - Switch active tabs in both windows and confirm new thumbnails arrive after navigation completes.
5. **Restricted pages**
   - Navigate one tab to `chrome://extensions` and confirm the node shows a “Capture blocked” badge.
6. **Node interactions**
   - Left-click a node and ensure the underlying tab becomes active and its window focuses.
   - Right-click a node and confirm the tab closes and the node disappears from the graph.
7. **Persistence check**
   - Reload the extension page (or restart Chrome) and verify the graph rebuilds.
   - Activate a few tabs to repopulate thumbnails after restart.
8. **Status and overlays**
   - Watch the status strip for accurate counts of windows, tabs, pending and blocked thumbnails.
   - Hover nodes to see tooltips with title/domain; ensure badges disappear once thumbnails arrive.
