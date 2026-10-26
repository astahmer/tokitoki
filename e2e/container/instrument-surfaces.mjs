// Inspect runtime copies only; pointer input still invokes every production handler.
import fs from 'node:fs';
const file = process.argv[2];
let source = fs.readFileSync(file, 'utf8');
source = source.replace('id: accountCard', 'id: accountCard\n property string e2eAccount: account.provider + "@" + account.accountKey');
for (const label of ['Move up in Quotas', 'Move down in Quotas', 'Hide this account everywhere', 'Move earlier in the bar', 'Move later in the bar', 'Restore this account']) {
  source = source.replace(`tooltipText: "${label}"`, `Component.onCompleted: root.e2eSurfaceControls.push(this)\n tooltipText: "${label}"`);
}
source = source.replace('tooltipText: root.restoreAccountLabel(modelData)', 'Component.onCompleted: root.e2eSurfaceControls.push(this)\n tooltipText: root.restoreAccountLabel(modelData)');
source = source.replace('tooltipText: root.barAccountHidden(accountCard.account) ?', 'Component.onCompleted: root.e2eSurfaceControls.push(this)\n tooltipText: root.barAccountHidden(accountCard.account) ?');
source = source.replace('onClicked: root.hiddenAccountsExpanded = !root.hiddenAccountsExpanded', 'Component.onCompleted: { root.e2eFold = this }\n onClicked: root.hiddenAccountsExpanded = !root.hiddenAccountsExpanded');
source = source.replace('id: refreshButton', 'id: refreshButton\n Component.onCompleted: root.e2eRefresh = this');
const hook = `
 property var e2eSurfaceControls: []
 property var e2eFold: null
 property var e2eRefresh: null
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
     return JSON.stringify(found)
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
