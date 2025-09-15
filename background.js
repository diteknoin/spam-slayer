// background.js
// Ekstensi Pembasmi Spam - background service worker

// --- AUTHENTICATION ---
async function getAuthToken(interactive = true) {
  return new Promise((resolve, reject) => {
    chrome.identity.getAuthToken({ interactive }, (token) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
      } else {
        resolve(token);
      }
    });
  });
}

// --- UTIL: fetch with error handling ---
async function fetchJson(url, token, opts = {}) {
  const headers = Object.assign({}, opts.headers || {}, {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
  });
  const res = await fetch(url, Object.assign({}, opts, { headers }));
  const text = await res.text();
  try {
    const json = text ? JSON.parse(text) : null;
    if (!res.ok) {
      const msg =
        (json && json.error && json.error.message) ||
        `${res.status} ${res.statusText}`;
      throw new Error(msg);
    }
    return json;
  } catch (err) {
    // If response wasn't JSON, or parse failed
    if (!res.ok) throw err;
    return null;
  }
}

// --- BLOCKED WORDS ---
async function getBlockedWords() {
  const res = await fetch(chrome.runtime.getURL("blockedword.json"));
  return res.ok ? res.json() : [];
}

async function isSpam(text, blockedWords) {
  if (!text) return false;
  const lowerText = text.toLowerCase();
  return blockedWords.some((word) =>
    lowerText.includes(String(word).toLowerCase())
  );
}

// --- COMMENTS (with pagination) ---
async function fetchCommentsForVideo(token, videoId) {
  const items = [];
  let pageToken = "";
  do {
    const url =
      `https://www.googleapis.com/youtube/v3/commentThreads?part=snippet&videoId=${encodeURIComponent(
        videoId
      )}&maxResults=100` + (pageToken ? `&pageToken=${pageToken}` : "");
    const data = await fetchJson(url, token);
    if (data && data.items) items.push(...data.items);
    pageToken = data && data.nextPageToken ? data.nextPageToken : "";
  } while (pageToken);
  return items;
}

// --- DELETE COMMENTS (returns number actually deleted) ---
async function deleteComments(token, commentIds) {
  let deleted = 0;
  for (const id of commentIds) {
    try {
      const url = `https://www.googleapis.com/youtube/v3/comments/setModerationStatus?id=${encodeURIComponent(
        id
      )}&moderationStatus=rejected`;
      const res = await fetch(url, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
      });
      if (res.ok) {
        deleted++;
        console.log("🗑️ Deleted comment:", id);
      } else {
        const text = await res.text();
        console.warn("Failed to delete comment:", id, res.status, text);
      }
    } catch (err) {
      console.error("Error deleting comment:", id, err);
    }
  }
  return deleted;
}

// --- PLAYLIST VIDEOS (uploads) ---
async function getAllUploadVideos(token, uploadsPlaylistId) {
  const videos = [];
  let pageToken = "";
  do {
    const url =
      `https://www.googleapis.com/youtube/v3/playlistItems?part=snippet&maxResults=50&playlistId=${encodeURIComponent(
        uploadsPlaylistId
      )}` + (pageToken ? `&pageToken=${pageToken}` : "");
    const data = await fetchJson(url, token);
    if (data && data.items) videos.push(...data.items);
    pageToken = data && data.nextPageToken ? data.nextPageToken : "";
  } while (pageToken);
  return videos;
}

// --- MAIN: fetch videos, scan comments, delete spam ---
async function fetchVideos() {
  // totalDeleted declared and used in same scope
  let totalDeleted = 0;

  // Get token
  const token = await getAuthToken(true);

  // 1) Get channel uploads playlist ID
  const channelData = await fetchJson(
    "https://www.googleapis.com/youtube/v3/channels?part=contentDetails&mine=true",
    token
  );
  if (!channelData || !channelData.items || channelData.items.length === 0) {
    throw new Error(
      "Tidak menemukan channel (pastikan akun yang dipilih benar)."
    );
  }
  const uploadsId =
    channelData.items[0].contentDetails.relatedPlaylists.uploads;
  console.log("Uploads playlist ID:", uploadsId);

  // 2) Get all videos from uploads playlist (handles pagination)
  const videos = await getAllUploadVideos(token, uploadsId);
  console.log("Found videos count:", videos.length);

  if (!videos.length) return totalDeleted;

  // 3) Load blocked words once
  const blockedWords = await getBlockedWords();

  // 4) For each video -> fetch comments -> detect spam -> delete
  for (const videoItem of videos) {
    try {
      const snippet = videoItem.snippet || {};
      const videoId = snippet.resourceId && snippet.resourceId.videoId;
      const title = snippet.title || videoId || "Unknown";
      if (!videoId) continue;

      console.log(`\n📹 Processing: ${title} (${videoId})`);

      const comments = await fetchCommentsForVideo(token, videoId);
      console.log("Comments fetched:", comments.length);

      const spamIds = [];
      for (const thread of comments) {
        const top =
          thread.snippet &&
          thread.snippet.topLevelComment &&
          thread.snippet.topLevelComment.snippet;
        const text = (top && (top.textDisplay || top.textOriginal)) || "";
        const id = thread.id;
        if (await isSpam(text, blockedWords)) {
          console.log("🚨 Spam detected:", text);
          spamIds.push(id);
        }
      }

      if (spamIds.length > 0) {
        const deletedCount = await deleteComments(token, spamIds);
        totalDeleted += deletedCount;
        console.log(
          `✅ Deleted ${deletedCount}/${spamIds.length} for video ${videoId}`
        );
      } else {
        console.log("✅ No spam for this video");
      }
    } catch (err) {
      console.error("Error processing a video:", err);
    }
  }

  // 5) Return total deleted count
  return totalDeleted;
}

// --- MESSAGE LISTENER (popup -> background) ---
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.action === "scanSpam") {
    fetchVideos()
      .then((deleted) => {
        if (deleted > 0) {
          sendResponse(`✅ Berhasil hapus ${deleted} komentar spam`);
        } else {
          sendResponse("✅ Tidak ada komentar spam ditemukan");
        }
      })
      .catch((err) => {
        console.error("Scan failed:", err);
        sendResponse("❌ Error: " + (err.message || err.toString()));
      });
    return true; // keep channel open
  }
});
