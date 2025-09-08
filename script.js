const address = document.getElementById("address");
const goBtn = document.getElementById("goBtn");
const view = document.getElementById("view");
const status = document.getElementById("status");
const cookieToggle = document.getElementById("cookieToggle");

goBtn.onclick = () => navigate(address.value);

function navigate(url) {
  if (!/^https?:\/\//i.test(url)) {
    url = "https://" + url;
  }
  status.textContent = "Loading " + url + "...";
  const cookieSetting = cookieToggle.checked ? "1" : "0";
  view.src = "/api/fetch?u=" + encodeURIComponent(url) + "&cookies=" + cookieSetting;
}

// Listen for messages from iframe
window.addEventListener("message", (event) => {
  if (event.data?.type === "virtualbrowse:loaded") {
    status.textContent = "Loaded: " + event.data.href;
    address.value = event.data.href;
  }
});
