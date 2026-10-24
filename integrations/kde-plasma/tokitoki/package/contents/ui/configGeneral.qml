import QtQuick
import QtQuick.Controls as QQC2
import QtQuick.Layouts
import org.kde.kirigami as Kirigami
Kirigami.FormLayout {
    property alias cfg_endpoint: endpoint.text
    property string cfg_displayMode
    property alias cfg_accounts: accounts.text
    property alias cfg_hideIdentities: privacy.checked
    QQC2.TextField { id: endpoint; Kirigami.FormData.label: "Tokitoki service:"; placeholderText: "http://127.0.0.1:6736"; Layout.preferredWidth: 330 }
    QQC2.Label { text: "Start tokitoki serve, or use port 7788 for tokitoki web." }
    QQC2.ComboBox {
        Kirigami.FormData.label: "Bar display:"
        model: ["Shortest window per account", "All quota windows", "Usage totals", "Icon only"]
        property var modes: ["shortest", "quotas", "total", "icon"]
        currentIndex: Math.max(0, modes.indexOf(cfg_displayMode))
        onActivated: cfg_displayMode = modes[currentIndex]
    }
    QQC2.TextField { id: accounts; Kirigami.FormData.label: "Account IDs:"; placeholderText: "codex@work,cursor@personal"; Layout.preferredWidth: 330 }
    QQC2.Label { text: "Comma-separated provider@accountKey IDs; empty shows all accounts."; wrapMode: Text.Wrap; Layout.maximumWidth: 420 }
    QQC2.CheckBox { id: privacy; text: "Hide account identities" }
}
