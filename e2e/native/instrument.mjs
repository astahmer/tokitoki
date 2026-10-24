// Test-only probes are added to runtime copies; production adapters expose no testing IPC.
import fs from 'node:fs';
const home = process.env.HOME;
const widget = home + '/.local/share/noctalia/plugins/tokitoki/widget.luau';
fs.appendFileSync(widget, `
function onIpc(event, value)
  if event == "e2e-refresh" then refresh() return end
  if event ~= "e2e-state" then return end
  local rows = {}
  local now = noctalia.nowMs()
  for _, a in ipairs(accounts()) do
    local selected = {}
    for _, w in ipairs(model.rows(a, noctalia.getConfig("display_mode") == "shortest", now)) do
      table.insert(selected, model.windowLabel(w) .. " " .. model.value(w, now))
    end
    table.insert(rows, {id = a.id, name = a.name, windows = selected, fullCount = #model.rows(a, false, now)})
  end
  assert(model.epoch("1970-01-01T00:00:00.000Z") == 0)
  assert(model.epoch("2026-10-24T12:00:00Z") == 1792843200000)
  assert(model.epoch("2026-10-24T14:00:00+02:00") == 1792843200000)
  noctalia.log("E2E_STATE " .. noctalia.json.encode({mode = noctalia.getConfig("display_mode"), accounts = rows, error = lastError or "", labelUnknown = model.windowLabel({}), valueUnknown = model.value({}, now)}))
end
`);
const target = '/tmp/native-plasma';
fs.cpSync('/repo/integrations/kde-plasma/tokitoki/package',target,{recursive:true});
const main = target + '/contents/ui/main.qml';
let qml = fs.readFileSync(main,'utf8');
qml = qml.replace('id: root', `id: root
    property int e2eRevision: -1
    Timer {
        interval: 200; repeat: true; running: true
        onTriggered: {
            var req = new XMLHttpRequest()
            req.onreadystatechange = function() {
                if (req.readyState !== XMLHttpRequest.DONE || req.status !== 200) return
                var c = JSON.parse(req.responseText)
                if (c.revision === root.e2eRevision) return
                root.e2eRevision = c.revision
                if (c.mode !== undefined) Plasmoid.configuration.displayMode = c.mode
                if (c.accounts !== undefined) Plasmoid.configuration.accounts = c.accounts
                if (c.privacy !== undefined) Plasmoid.configuration.hideIdentities = c.privacy
                if (c.expanded !== undefined) root.expanded = c.expanded
                if (c.refresh) root.refresh()
                if (c.configure) root.Plasmoid.internalAction("configure").trigger()
                probe.restart()
            }
            req.open("GET", "http://127.0.0.1:6736/e2e/control"); req.send()
        }
    }
    Timer {
        id: probe; interval: 400
        onTriggered: {
            var req = new XMLHttpRequest()
            req.open("POST", "http://127.0.0.1:6736/e2e/state")
            var point = root.mapToGlobal(0, 0)
            function textNodes(item) {
                if (!item) return []
                var result = typeof item.text === "string" ? [item.text] : []
                for (var i = 0; i < item.children.length; i++) result = result.concat(textNodes(item.children[i]))
                return result
            }
            req.send(JSON.stringify({revision:root.e2eRevision,accounts:root.accounts,bar:root.barText,tooltip:root.toolTipSubText,error:root.errorText,expanded:root.expanded,mode:Plasmoid.configuration.displayMode,renderedText:textNodes(root.fullRepresentationItem),bounds:{x:Math.round(point.x),y:Math.round(point.y),width:Math.round(root.width),height:Math.round(root.height)}}))
        }
    }
`);
fs.writeFileSync(main,qml);
