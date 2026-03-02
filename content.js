// Function to extract repo owner and name from the URL
function getRepoInfo() {
  const pathParts = window.location.pathname.split("/").filter(part => part !== "");
  if (pathParts.length >= 2) {
    return {
      owner: pathParts[0],
      repo: pathParts[1]
    };
  }
  return null;
}

// Send repo info to the background script or side panel
chrome.runtime.sendMessage({
  type: "REPO_INFO",
  data: getRepoInfo()
});

console.log("GitHub Repo Analyzer content script loaded.", getRepoInfo());
