const scanBtn = document.getElementById("scan");
const statusBox = document.getElementById("status");

function showStatus(message, type) {
  statusBox.textContent = message;
  statusBox.className = type;
  statusBox.style.display = "block";
}

scanBtn.addEventListener("click", () => {
  showStatus("⏳ Sedang memindai komentar...", "loading");

  chrome.runtime.sendMessage({ action: "scanSpam" }, (response) => {
    if (response.startsWith("✅")) {
      showStatus(response, "success");
    } else {
      showStatus(response, "error");
    }
  });
});
