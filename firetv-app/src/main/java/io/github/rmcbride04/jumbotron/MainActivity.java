package io.github.rmcbride04.jumbotron;

import android.annotation.SuppressLint;
import android.app.Activity;
import android.net.Uri;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.view.WindowManager;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;

/** Shows the Jumbotron web page full screen, with no browser bars. */
public class MainActivity extends Activity {
    // "app=1" tells the page it doesn't need its full-screen button.
    private static final String PAGE_URL = "https://rmcbride04.github.io/jumbotron/?app=1";
    private static final String PAGE_HOST = "rmcbride04.github.io";
    private static final int RETRY_MS = 15000;
    private static final String WAITING_PAGE =
            "<body style='background:#07090f;color:#9aa6bb;font:5vw sans-serif;"
            + "display:flex;align-items:center;justify-content:center;height:90vh'>"
            + "Connecting&hellip;</body>";

    private final Handler handler = new Handler(Looper.getMainLooper());
    private final Runnable reload = new Runnable() {
        @Override
        public void run() {
            webView.loadUrl(PAGE_URL);
        }
    };
    private WebView webView;

    @SuppressLint("SetJavaScriptEnabled")
    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        // Keeps the screen on and the screensaver away while the app is open.
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);

        webView = new WebView(this);
        webView.setBackgroundColor(0xFF07090F);
        WebSettings settings = webView.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);
        webView.setWebViewClient(new PageClient());
        setContentView(webView);
        webView.requestFocus();
        webView.loadUrl(PAGE_URL);
    }

    private class PageClient extends WebViewClient {
        // The app only ever shows the dashboard.
        @Override
        @SuppressWarnings("deprecation")
        public boolean shouldOverrideUrlLoading(WebView view, String url) {
            return !PAGE_HOST.equals(Uri.parse(url).getHost());
        }

        // If the TV's Wi-Fi isn't ready yet, keep trying instead of showing an error.
        @Override
        @SuppressWarnings("deprecation")
        public void onReceivedError(WebView view, int code, String description, String url) {
            view.loadData(WAITING_PAGE, "text/html", "UTF-8");
            handler.removeCallbacks(reload);
            handler.postDelayed(reload, RETRY_MS);
        }
    }

    // Stops checking scores in the background when you leave for another app.
    @Override
    protected void onPause() {
        webView.onPause();
        webView.pauseTimers();
        super.onPause();
    }

    @Override
    protected void onResume() {
        super.onResume();
        webView.onResume();
        webView.resumeTimers();
    }

    @Override
    protected void onDestroy() {
        handler.removeCallbacks(reload);
        webView.destroy();
        super.onDestroy();
    }
}
