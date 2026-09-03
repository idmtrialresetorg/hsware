'use strict';

// Bundled curated starter catalog. Keeping this data in a JS module avoids
// runtime filesystem paths that change when Next.js bundles server code.
const STARTER_PACKAGES = [
  {
    "rank": 1,
    "packageId": "Google.Chrome",
    "name": "Google Chrome",
    "category": "Browser",
    "publisher": "Google"
  },
  {
    "rank": 2,
    "packageId": "Mozilla.Firefox",
    "name": "Mozilla Firefox",
    "category": "Browser",
    "publisher": "Mozilla"
  },
  {
    "rank": 3,
    "packageId": "VideoLAN.VLC",
    "name": "VLC media player",
    "category": "Media",
    "publisher": "VideoLAN"
  },
  {
    "rank": 4,
    "packageId": "7zip.7zip",
    "name": "7-Zip",
    "category": "Utilities",
    "publisher": "7zip"
  },
  {
    "rank": 5,
    "packageId": "RARLab.WinRAR",
    "name": "WinRAR",
    "category": "Utilities",
    "publisher": "RARLab"
  },
  {
    "rank": 6,
    "packageId": "Notepad++.Notepad++",
    "name": "Notepad++",
    "category": "Developer",
    "publisher": "Notepad++"
  },
  {
    "rank": 7,
    "packageId": "Microsoft.VisualStudioCode",
    "name": "Visual Studio Code",
    "category": "Developer",
    "publisher": "Microsoft"
  },
  {
    "rank": 8,
    "packageId": "OBSProject.OBSStudio",
    "name": "OBS Studio",
    "category": "Media",
    "publisher": "OBSProject"
  },
  {
    "rank": 9,
    "packageId": "Discord.Discord",
    "name": "Discord",
    "category": "Communication",
    "publisher": "Discord"
  },
  {
    "rank": 10,
    "packageId": "Telegram.TelegramDesktop",
    "name": "Telegram Desktop",
    "category": "Communication",
    "publisher": "Telegram"
  },
  {
    "rank": 11,
    "packageId": "Zoom.Zoom",
    "name": "Zoom",
    "category": "Communication",
    "publisher": "Zoom"
  },
  {
    "rank": 12,
    "packageId": "Spotify.Spotify",
    "name": "Spotify",
    "category": "Media",
    "publisher": "Spotify"
  },
  {
    "rank": 13,
    "packageId": "Valve.Steam",
    "name": "Steam",
    "category": "Games",
    "publisher": "Valve"
  },
  {
    "rank": 14,
    "packageId": "EpicGames.EpicGamesLauncher",
    "name": "Epic Games Launcher",
    "category": "Games",
    "publisher": "EpicGames"
  },
  {
    "rank": 15,
    "packageId": "Git.Git",
    "name": "Git",
    "category": "Developer",
    "publisher": "Git"
  },
  {
    "rank": 16,
    "packageId": "GitHub.GitHubDesktop",
    "name": "GitHub Desktop",
    "category": "Developer",
    "publisher": "GitHub"
  },
  {
    "rank": 17,
    "packageId": "Audacity.Audacity",
    "name": "Audacity",
    "category": "Media",
    "publisher": "Audacity"
  },
  {
    "rank": 18,
    "packageId": "GIMP.GIMP",
    "name": "GIMP",
    "category": "Graphics",
    "publisher": "GIMP"
  },
  {
    "rank": 19,
    "packageId": "BlenderFoundation.Blender",
    "name": "Blender",
    "category": "Graphics",
    "publisher": "BlenderFoundation"
  },
  {
    "rank": 20,
    "packageId": "Inkscape.Inkscape",
    "name": "Inkscape",
    "category": "Graphics",
    "publisher": "Inkscape"
  },
  {
    "rank": 21,
    "packageId": "HandBrake.HandBrake",
    "name": "HandBrake",
    "category": "Media",
    "publisher": "HandBrake"
  },
  {
    "rank": 22,
    "packageId": "qBittorrent.qBittorrent",
    "name": "qBittorrent",
    "category": "Internet",
    "publisher": "qBittorrent"
  },
  {
    "rank": 23,
    "packageId": "Bitwarden.Bitwarden",
    "name": "Bitwarden",
    "category": "Security",
    "publisher": "Bitwarden"
  },
  {
    "rank": 24,
    "packageId": "voidtools.Everything",
    "name": "Everything",
    "category": "Utilities",
    "publisher": "voidtools"
  },
  {
    "rank": 25,
    "packageId": "Oracle.VirtualBox",
    "name": "VirtualBox",
    "category": "Virtualization",
    "publisher": "Oracle"
  },
  {
    "rank": 26,
    "packageId": "Docker.DockerDesktop",
    "name": "Docker Desktop",
    "category": "Developer",
    "publisher": "Docker"
  },
  {
    "rank": 27,
    "packageId": "PuTTY.PuTTY",
    "name": "PuTTY",
    "category": "Developer",
    "publisher": "PuTTY"
  },
  {
    "rank": 28,
    "packageId": "WinSCP.WinSCP",
    "name": "WinSCP",
    "category": "Internet",
    "publisher": "WinSCP"
  },
  {
    "rank": 30,
    "packageId": "TeamViewer.TeamViewer",
    "name": "TeamViewer",
    "category": "Remote Access",
    "publisher": "TeamViewer"
  },
  {
    "rank": 31,
    "packageId": "AnyDeskSoftwareGmbH.AnyDesk",
    "name": "AnyDesk",
    "category": "Remote Access",
    "publisher": "AnyDeskSoftwareGmbH"
  },
  {
    "rank": 32,
    "packageId": "RustDesk.RustDesk",
    "name": "RustDesk",
    "category": "Remote Access",
    "publisher": "RustDesk"
  },
  {
    "rank": 33,
    "packageId": "CPUID.CPU-Z",
    "name": "CPU-Z",
    "category": "System",
    "publisher": "CPUID"
  },
  {
    "rank": 34,
    "packageId": "TechPowerUp.GPU-Z",
    "name": "GPU-Z",
    "category": "System",
    "publisher": "TechPowerUp"
  },
  {
    "rank": 35,
    "packageId": "CrystalDewWorld.CrystalDiskInfo",
    "name": "CrystalDiskInfo",
    "category": "System",
    "publisher": "CrystalDewWorld"
  },
  {
    "rank": 36,
    "packageId": "CrystalDewWorld.CrystalDiskMark",
    "name": "CrystalDiskMark",
    "category": "System",
    "publisher": "CrystalDewWorld"
  },
  {
    "rank": 37,
    "packageId": "Microsoft.PowerToys",
    "name": "Microsoft PowerToys",
    "category": "Utilities",
    "publisher": "Microsoft"
  },
  {
    "rank": 38,
    "packageId": "Microsoft.WindowsTerminal",
    "name": "Windows Terminal",
    "category": "Developer",
    "publisher": "Microsoft"
  },
  {
    "rank": 39,
    "packageId": "Microsoft.Sysinternals.ProcessExplorer",
    "name": "Process Explorer",
    "category": "System",
    "publisher": "Microsoft"
  },
  {
    "rank": 40,
    "packageId": "Microsoft.Sysinternals.Autoruns",
    "name": "Autoruns",
    "category": "System",
    "publisher": "Microsoft"
  },
  {
    "rank": 41,
    "packageId": "Greenshot.Greenshot",
    "name": "Greenshot",
    "category": "Graphics",
    "publisher": "Greenshot"
  },
  {
    "rank": 42,
    "packageId": "ShareX.ShareX",
    "name": "ShareX",
    "category": "Graphics",
    "publisher": "ShareX"
  },
  {
    "rank": 43,
    "packageId": "Flameshot.Flameshot",
    "name": "Flameshot",
    "category": "Graphics",
    "publisher": "Flameshot"
  },
  {
    "rank": 44,
    "packageId": "SumatraPDF.SumatraPDF",
    "name": "SumatraPDF",
    "category": "PDF",
    "publisher": "SumatraPDF"
  },
  {
    "rank": 45,
    "packageId": "Adobe.Acrobat.Reader.64-bit",
    "name": "Adobe Acrobat Reader",
    "category": "PDF",
    "publisher": "Adobe"
  },
  {
    "rank": 46,
    "packageId": "calibre.calibre",
    "name": "calibre",
    "category": "Productivity",
    "publisher": "calibre"
  },
  {
    "rank": 47,
    "packageId": "LibreOffice.LibreOffice",
    "name": "LibreOffice",
    "category": "Productivity",
    "publisher": "LibreOffice"
  },
  {
    "rank": 48,
    "packageId": "ONLYOFFICE.DesktopEditors",
    "name": "ONLYOFFICE Desktop Editors",
    "category": "Productivity",
    "publisher": "ONLYOFFICE"
  },
  {
    "rank": 49,
    "packageId": "Microsoft.Edge",
    "name": "Microsoft Edge",
    "category": "Browser",
    "publisher": "Microsoft"
  },
  {
    "rank": 50,
    "packageId": "OpenJS.NodeJS.LTS",
    "name": "Node.js LTS",
    "category": "Developer",
    "publisher": "OpenJS"
  },
  {
    "rank": 51,
    "packageId": "Python.Python.3.13",
    "name": "Python 3.13",
    "category": "Developer",
    "publisher": "Python"
  },
  {
    "rank": 52,
    "packageId": "Postman.Postman",
    "name": "Postman",
    "category": "Developer",
    "publisher": "Postman"
  },
  {
    "rank": 53,
    "packageId": "Insomnia.Insomnia",
    "name": "Insomnia",
    "category": "Developer",
    "publisher": "Insomnia"
  },
  {
    "rank": 54,
    "packageId": "JetBrains.Toolbox",
    "name": "JetBrains Toolbox",
    "category": "Developer",
    "publisher": "JetBrains"
  },
  {
    "rank": 55,
    "packageId": "Microsoft.VisualStudio.2022.Community",
    "name": "Visual Studio 2022 Community",
    "category": "Developer",
    "publisher": "Microsoft"
  },
  {
    "rank": 56,
    "packageId": "OpenVPNTechnologies.OpenVPNConnect",
    "name": "OpenVPN Connect",
    "category": "Security",
    "publisher": "OpenVPNTechnologies"
  },
  {
    "rank": 57,
    "packageId": "WireGuard.WireGuard",
    "name": "WireGuard",
    "category": "Security",
    "publisher": "WireGuard"
  },
  {
    "rank": 58,
    "packageId": "Proton.ProtonVPN",
    "name": "Proton VPN",
    "category": "Security",
    "publisher": "Proton"
  },
  {
    "rank": 59,
    "packageId": "Cloudflare.Warp",
    "name": "Cloudflare WARP",
    "category": "Security",
    "publisher": "Cloudflare"
  },
  {
    "rank": 60,
    "packageId": "Malwarebytes.Malwarebytes",
    "name": "Malwarebytes",
    "category": "Security",
    "publisher": "Malwarebytes"
  },
  {
    "rank": 61,
    "packageId": "KeePassXCTeam.KeePassXC",
    "name": "KeePassXC",
    "category": "Security",
    "publisher": "KeePassXCTeam"
  },
  {
    "rank": 62,
    "packageId": "PeaZip.PeaZip",
    "name": "PeaZip",
    "category": "Utilities",
    "publisher": "PeaZip"
  },
  {
    "rank": 63,
    "packageId": "NanaZip.NanaZip",
    "name": "NanaZip",
    "category": "Utilities",
    "publisher": "NanaZip"
  },
  {
    "rank": 64,
    "packageId": "Microsoft.OneDrive",
    "name": "Microsoft OneDrive",
    "category": "Cloud",
    "publisher": "Microsoft"
  },
  {
    "rank": 65,
    "packageId": "Dropbox.Dropbox",
    "name": "Dropbox",
    "category": "Cloud",
    "publisher": "Dropbox"
  },
  {
    "rank": 66,
    "packageId": "Google.GoogleDrive",
    "name": "Google Drive",
    "category": "Cloud",
    "publisher": "Google"
  },
  {
    "rank": 67,
    "packageId": "Apple.iTunes",
    "name": "iTunes",
    "category": "Media",
    "publisher": "Apple"
  },
  {
    "rank": 68,
    "packageId": "Apple.iCloud",
    "name": "iCloud",
    "category": "Cloud",
    "publisher": "Apple"
  },
  {
    "rank": 69,
    "packageId": "Microsoft.Teams",
    "name": "Microsoft Teams",
    "category": "Communication",
    "publisher": "Microsoft"
  },
  {
    "rank": 70,
    "packageId": "SlackTechnologies.Slack",
    "name": "Slack",
    "category": "Communication",
    "publisher": "SlackTechnologies"
  },
  {
    "rank": 71,
    "packageId": "Signal.Signal",
    "name": "Signal",
    "category": "Communication",
    "publisher": "Signal"
  },
  {
    "rank": 72,
    "packageId": "WhatsApp.WhatsApp",
    "name": "WhatsApp",
    "category": "Communication",
    "publisher": "WhatsApp"
  },
  {
    "rank": 73,
    "packageId": "Wondershare.Filmora",
    "name": "Wondershare Filmora",
    "category": "Media",
    "publisher": "Wondershare"
  },
  {
    "rank": 74,
    "packageId": "BlackmagicDesign.DaVinciResolve",
    "name": "DaVinci Resolve",
    "category": "Media",
    "publisher": "BlackmagicDesign"
  },
  {
    "rank": 75,
    "packageId": "Brave.Brave",
    "name": "Brave Browser",
    "category": "Browser",
    "publisher": "Brave"
  }
];

function starterPackages() {
  return STARTER_PACKAGES;
}

module.exports = { STARTER_PACKAGES, starterPackages };
