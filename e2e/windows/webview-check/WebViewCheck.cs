using System;
using System.Drawing;
using System.IO;
using System.Threading.Tasks;
using System.Windows.Forms;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.WinForms;

static class WebViewCheck {
    const string ShareDirectory = @"Z:\e2e\webview-check";

    [STAThread]
    static void Main() {
        Application.EnableVisualStyles();
        Application.SetCompatibleTextRenderingDefault(false);

        string baseDirectory = AppDomain.CurrentDomain.BaseDirectory;
        string htmlPath = Path.Combine(baseDirectory, "check.html");
        string userData = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "tokitoki", "webview-check");
        Directory.CreateDirectory(userData);

        Form form = new Form();
        form.Text = "tokitoki webview check";
        form.StartPosition = FormStartPosition.CenterScreen;
        form.Width = 1100;
        form.Height = 700;
        form.TopMost = true;
        form.BackColor = Color.FromArgb(16, 36, 28);

        Label status = new Label();
        status.Dock = DockStyle.Fill;
        status.TextAlign = ContentAlignment.MiddleCenter;
        status.ForeColor = Color.White;
        status.BackColor = Color.FromArgb(16, 36, 28);
        status.Font = new Font("Segoe UI", 32, FontStyle.Bold);
        status.Text = "STARTING";
        form.Controls.Add(status);

        WebView2 web = new WebView2();
        web.Dock = DockStyle.Fill;
        web.Visible = false;
        form.Controls.Add(web);

        form.Shown += delegate {
            CoreWebView2Environment.CreateAsync(null, userData).ContinueWith(delegate(Task<CoreWebView2Environment> envTask) {
                form.BeginInvoke((Action)delegate {
                    if (envTask.IsFaulted) {
                        ReportFailure(status, envTask.Exception);
                        return;
                    }
                    web.EnsureCoreWebView2Async(envTask.Result).ContinueWith(delegate(Task ready) {
                        form.BeginInvoke((Action)delegate {
                            if (ready.IsFaulted) {
                                ReportFailure(status, ready.Exception);
                                return;
                            }
                            status.Visible = false;
                            web.Visible = true;
                            web.CoreWebView2.Navigate(new Uri(htmlPath).AbsoluteUri);
                        });
                    });
                });
            });
        };

        Application.Run(form);
    }

    static void ReportFailure(Label status, Exception error) {
        status.Text = "WEBVIEW2 FAILED";
        status.ForeColor = Color.FromArgb(255, 90, 90);
        try {
            Directory.CreateDirectory(ShareDirectory);
            File.WriteAllText(Path.Combine(ShareDirectory, "webview-error.txt"), error.ToString());
        } catch (Exception writeError) {
            status.Text = "WEBVIEW2 FAILED\n" + writeError.Message;
        }
    }
}
