const MAX_SIZE = 5 * 1024 * 1024 * 1024;

function json(data, status = 200) {
  return Response.json(data, {
    status,
    headers: { "Cache-Control": "no-store" }
  });
}

function allowedHost(host, env) {
  const list = (env.ALLOWED_SOURCE_HOSTS || "")
    .split(",")
    .map(s => s.trim().toLowerCase())
    .filter(Boolean);

  return list.includes(host.toLowerCase());
}

function checkUrl(value, env) {
  const u = new URL(value);

  if (u.protocol !== "https:") {
    throw new Error("শুধু HTTPS URL ব্যবহার করুন।");
  }

  if (u.username || u.password) {
    throw new Error("URL-এর মধ্যে username/password দেওয়া যাবে না।");
  }

  if (!allowedHost(u.hostname, env)) {
    throw new Error(
      "এই ডোমেইন অনুমোদিত নয়। ALLOWED_SOURCE_HOSTS-এ ডোমেইনটি যোগ করুন।"
    );
  }

  return u;
}

function getVideoUrl(html, pageUrl) {
  const patterns = [
    /<video\b[^>]*\bsrc=["']([^"']+)["']/i,
    /<source\b[^>]*\bsrc=["']([^"']+)["']/i,
    /<meta\b[^>]*\bproperty=["']og:video(?::url)?["'][^>]*\bcontent=["']([^"']+)["']/i,
    /<meta\b[^>]*\bcontent=["']([^"']+)["'][^>]*\bproperty=["']og:video(?::url)?["']/i,
    /<meta\b[^>]*\bname=["']twitter:player:stream["'][^>]*\bcontent=["']([^"']+)["']/i
  ];

  for (const pattern of patterns) {
    const match = html.match(pattern);
    if (match && match[1]) {
      return new URL(
        match[1].replace(/&amp;/g, "&"),
        pageUrl
      ).href;
    }
  }

  return null;
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === "GET" && url.pathname === "/") {
      return new Response(`<!doctype html>
<html lang="bn">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>R2 Remote Video Upload</title>
<style>
body{font-family:system-ui,sans-serif;max-width:720px;margin:25px auto;padding:0 15px}
input,button{box-sizing:border-box;width:100%;padding:12px;margin:7px 0}
button{cursor:pointer}
small{color:#555}
#status{white-space:pre-wrap;overflow-wrap:anywhere}
</style>
</head>
<body>
<h2>R2 Remote Video Upload</h2>
<p>সরাসরি ভিডিও URL অথবা ভিডিও থাকা ওয়েবপেজের URL দিন।</p>
<form id="uploadForm">
<label>Admin token</label>
<input id="token" type="password" required autocomplete="off">
<label>ভিডিও বা ওয়েবপেজ URL</label>
<input id="source" type="url" placeholder="https://example.com/video.mp4" required>
<label>R2 ফাইলের নাম (ঐচ্ছিক)</label>
<input id="filename" placeholder="my-video.mp4">
<button id="submit" type="submit">Remote Upload শুরু করুন</button>
</form>
<p id="status">প্রস্তুত।</p>
<script>
const form = document.getElementById("uploadForm");
const status = document.getElementById("status");
const button = document.getElementById("submit");

form.addEventListener("submit", async e => {
  e.preventDefault();
  button.disabled = true;
  status.textContent = "রিমোট ভিডিও আনা হচ্ছে… বড় ফাইলের জন্য অপেক্ষা করতে হতে পারে।";

  try {
    const res = await fetch("/api/upload", {
      method: "POST",
      headers: {
        "Authorization": "Bearer " + document.getElementById("token").value,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        source: document.getElementById("source").value.trim(),
        filename: document.getElementById("filename").value.trim()
      })
    });

    const data = await res.json();
    if (!res.ok || !data.success) {
      throw new Error(data.error || "আপলোড ব্যর্থ হয়েছে।");
    }

    status.textContent =
      "আপলোড সফল!\\nR2 Key: " + data.key +
      "\\nSize: " + data.size + " bytes" +
      "\\nContent-Type: " + data.contentType;
  } catch (err) {
    status.textContent = "সমস্যা: " + err.message;
  } finally {
    button.disabled = false;
  }
});
</script>
</body>
</html>`, {
        headers: {
          "Content-Type": "text/html; charset=UTF-8",
          "Cache-Control": "no-store"
        }
      });
    }

    if (url.pathname !== "/api/upload" || request.method !== "POST") {
      return new Response("Not found", { status: 404 });
    }

    if (!env.ADMIN_TOKEN || !env.VIDEOS) {
      return json({
        success: false,
        error: "ADMIN_TOKEN secret অথবা VIDEOS R2 binding সেট করা নেই।"
      }, 500);
    }

    if (request.headers.get("Authorization") !==
        "Bearer " + env.ADMIN_TOKEN) {
      return json({
        success: false,
        error: "Admin token ভুল।"
      }, 401);
    }

    try {
      const body = await request.json();
      let sourceUrl = checkUrl(body.source || "", env);
      let response = await fetch(sourceUrl.href, {
        method: "GET",
        redirect: "manual",
        headers: { "User-Agent": "R2-Remote-Uploader/1.0" }
      });

      if (response.status >= 300 && response.status < 400) {
        return json({
          success: false,
          error: "Source redirect করেছে। প্রথমে সরাসরি ভিডিও URL ব্যবহার করুন।"
        }, 400);
      }

      if (!response.ok) {
        return json({
          success: false,
          error: "Source URL থেকে HTTP " + response.status + " পাওয়া গেছে।"
        }, 400);
      }

      let contentType =
        (response.headers.get("content-type") || "").toLowerCase();

      // If the URL returns an HTML page, look for a direct video URL.
      if (contentType.includes("text/html")) {
        const pageLength = Number(
          response.headers.get("content-length") || 0
        );

        if (pageLength > 5 * 1024 * 1024) {
          return json({
            success: false,
            error: "ভিডিও পেজটি ৫ MB-এর বেশি; সরাসরি ভিডিও URL দিন।"
          }, 400);
        }

        const html = await response.text();

        if (html.length > 5 * 1024 * 1024) {
          return json({
            success: false,
            error: "ভিডিও পেজটি খুব বড়; সরাসরি ভিডিও URL দিন।"
          }, 400);
        }

        const direct = getVideoUrl(html, sourceUrl.href);

        if (!direct) {
          return json({
            success: false,
            error: "পেজে সাধারণ video/source/og:video লিংক পাওয়া যায়নি।"
          }, 400);
        }

        sourceUrl = checkUrl(direct, env);
        response = await fetch(sourceUrl.href, {
          method: "GET",
          redirect: "manual",
          headers: { "User-Agent": "R2-Remote-Uploader/1.0" }
        });

        if (response.status >= 300 && response.status < 400) {
          return json({
            success: false,
            error: "ভিডিও URL redirect করেছে; redirect ছাড়া সরাসরি URL দিন।"
          }, 400);
        }

        if (!response.ok) {
          return json({
            success: false,
            error: "ভিডিও URL থেকে HTTP " + response.status + " পাওয়া গেছে।"
          }, 400);
        }

        contentType =
          (response.headers.get("content-type") || "").toLowerCase();
      }

      if (
        contentType.includes("mpegurl") ||
        sourceUrl.pathname.toLowerCase().endsWith(".m3u8")
      ) {
        return json({
          success: false,
          error: "এটি HLS playlist। এই কোড playlist-কে MP4-তে রূপান্তর করে না।"
        }, 400);
      }

      const lengthHeader = response.headers.get("content-length");
      const size = Number(lengthHeader);

      if (!lengthHeader || !Number.isSafeInteger(size) || size <= 0) {
        return json({
          success: false,
          error: "Source-এর সঠিক Content-Length নেই; নিরাপদে size যাচাই করা যাচ্ছে না।"
        }, 400);
      }

      if (size > MAX_SIZE) {
        return json({
          success: false,
          error: "ফাইল ৫ GiB সীমার চেয়ে বড়।"
        }, 413);
      }

      const looksLikeVideo =
        contentType.startsWith("video/") ||
        /\.(mp4|m4v|webm|mov|mkv|avi)$/i.test(sourceUrl.pathname);

      if (!looksLikeVideo) {
        return json({
          success: false,
          error: "Source-টি সরাসরি ভিডিও ফাইল বলে শনাক্ত হয়নি।"
        }, 400);
      }

      let filename = String(body.filename || "").trim();
      if (!filename) {
        filename = sourceUrl.pathname.split("/").pop() || "video.mp4";
      }

      filename = filename
        .replace(/[^a-zA-Z0-9._-]/g, "_")
        .slice(-120);

      if (!/\.(mp4|m4v|webm|mov|mkv|avi)$/i.test(filename)) {
        filename += ".mp4";
      }

      const key = "videos/" + Date.now() + "-" + filename;

      // Stream the source directly into R2; do not buffer the full video.
      await env.VIDEOS.put(key, response.body, {
        httpMetadata: {
          contentType: contentType || "application/octet-stream"
        }
      });

      return json({
        success: true,
        key,
        size,
        contentType: contentType || "application/octet-stream"
      });
    } catch (error) {
      return json({
        success: false,
        error: error.message || "অজানা ত্রুটি হয়েছে।"
      }, 400);
    }
  }
};
