// Inspect runtime copies only; pointer input still invokes every production handler.
import fs from 'node:fs';
const file = process.argv[2];
let source = fs.readFileSync(file, 'utf8');
// A missing anchor means the widget changed; fail loudly instead of
// producing a run with silently uninstrumented controls.
const patch = (anchor, replacement) => {
  if (!source.includes(anchor)) throw new Error(`instrument-surfaces: anchor not found: ${anchor}`);
  source = source.replace(anchor, replacement);
};
patch('id: accountCard', 'id: accountCard\n property string e2eAccount: account.provider + "@" + account.accountKey');
for (const label of ['Move up in Quotas', 'Move down in Quotas', 'Hide this account everywhere', 'Move earlier in the bar', 'Move later in the bar']) {
  patch(`tooltipText: "${label}"`, `Component.onCompleted: root.e2eSurfaceControls.push(this)\n tooltipText: "${label}"`);
}
patch('tooltipText: root.restoreAccountLabel(modelData)', 'Component.onCompleted: root.e2eSurfaceControls.push(this)\n tooltipText: root.restoreAccountLabel(modelData)');
patch('tooltipText: providerFiltered ?', 'Component.onCompleted: root.e2eSurfaceControls.push(this)\n tooltipText: providerFiltered ?');
patch('onClicked: root.hiddenAccountsExpanded = !root.hiddenAccountsExpanded', 'Component.onCompleted: { root.e2eFold = this }\n onClicked: root.hiddenAccountsExpanded = !root.hiddenAccountsExpanded');
patch('id: refreshButton', 'id: refreshButton\n Component.onCompleted: root.e2eRefresh = this');
patch('id: layoutButton', 'id: layoutButton\n Component.onCompleted: root.e2eLayout = this');
// Navigation: the four primary tabs, the More button and its menu entries.
patch('id: navHover', 'id: navHover\n Component.onCompleted: root.e2eTabControls.push({ tab: modelData, item: this })');
patch('id: moreHover', 'id: moreHover\n Component.onCompleted: root.e2eMore = this');
patch('id: menuItemHover', 'id: menuItemHover\n Component.onCompleted: root.e2eTabControls.push({ tab: modelData, item: this })');
const hook = `
 property var e2eSurfaceControls: []
 property var e2eFold: null
 property var e2eRefresh: null
 property var e2eLayout: null
 property var e2eMore: null
 property var e2eTabControls: []
 function e2eBounds(item) {
   if (!item || !item.visible) return null
   var win = item.QsWindow.window
   if (!win) return null
   var c = win.mapFromItem(item, item.width / 2, item.height / 2)
   var x = win.anchors.left ? win.margins.left : win.screen.width - win.width - win.margins.right
   var y = win.anchors.top ? win.margins.top : win.screen.height - win.height - win.margins.bottom
   return {x: Math.round(x+c.x), y: Math.round(y+c.y)}
 }
 IpcHandler {
   target: "tokitoki-surfaces"
   function controls(): string {
     var found = []
     root.e2eSurfaceControls.forEach(function(item) {
       try {
         var b = root.e2eBounds(item)
         if (!b) return
         var owner = item.parent
         while (owner && owner.e2eAccount === undefined) owner = owner.parent
         found.push({label: item.tooltipText, account: owner ? owner.e2eAccount : "", enabled: item.enabled, x:b.x, y:b.y})
       } catch(e) {}
     })
     var fold = root.e2eBounds(root.e2eFold)
     if (fold) found.push({label:"expandHidden", enabled:true, x:fold.x, y:fold.y})
     var refresh = root.e2eBounds(root.e2eRefresh)
     if (refresh) found.push({label:"refresh",enabled:!root.isBusy,x:refresh.x,y:refresh.y})
     var layout = root.e2eBounds(root.e2eLayout)
     if (layout) found.push({label:"layout",enabled:true,x:layout.x,y:layout.y})
     return JSON.stringify(found)
   }
   // Where to click to reach a tab: its own control when visible, else More.
   function tabControl(tab: string): string {
     for (var i = 0; i < root.e2eTabControls.length; i++) {
       try {
         var entry = root.e2eTabControls[i]
         if (entry.tab !== tab) continue
         var b = root.e2eBounds(entry.item)
         if (b && b.x !== undefined) return JSON.stringify({kind:"tab", x:b.x, y:b.y})
       } catch(e) {}
     }
     var more = root.e2eBounds(root.e2eMore)
     return JSON.stringify(more ? {kind:"more", x:more.x, y:more.y} : {kind:"missing"})
   }
   function state(): string {
     function ids(accounts) { return accounts.map(function(a) { return a.provider+"@"+a.accountKey }) }
     return JSON.stringify({busy:root.isBusy, error:root.lastError, limits:root.payload.limits,
       ui:root.payload.uiPreview, strip:root.buildStatusStripGroups().map(function(g) {return {provider:g.provider, accounts:ids(g.accounts)}}), quotas:ids(root.filteredLimits()), hidden:ids(root.hiddenLimits()),
       bar:ids(root.orderedAccounts("bar").filter(function(a) { return !root.barAccountHidden(a) && root.providerIsVisible(a.provider,a.accountKey,a.vendor) })),
       expanded:root.hiddenAccountsExpanded, quotaOverride:root.accountOrderOverride,
       barOverride:root.barAccountOrderOverride, hiddenOverride:root.barHiddenOverride})
   }
 }
`;
const end = source.lastIndexOf('}');
fs.writeFileSync(file, source.slice(0,end) + hook + source.slice(end));
