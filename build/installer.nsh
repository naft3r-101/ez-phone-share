; Custom NSIS hooks injected by electron-builder.
; Adds a Windows Firewall inbound rule for the installed exe so the phone
; can reach the LAN port without a first-run prompt.

!macro customInstall
  DetailPrint "Adding Windows Firewall rule for Ez Phone Share..."
  ; Idempotent: remove any prior rule, then add a fresh one
  nsExec::Exec '"$SYSDIR\netsh.exe" advfirewall firewall delete rule name="Ez Phone Share"'
  Pop $0
  ; profile=private matches the default "Allow on Private networks" choice in
  ; the Windows Firewall prompt — i.e. trusted home/office Wi-Fi only, not
  ; public hotspots
  nsExec::Exec '"$SYSDIR\netsh.exe" advfirewall firewall add rule name="Ez Phone Share" dir=in action=allow program="$INSTDIR\Ez Phone Share.exe" enable=yes profile=private'
  Pop $0
!macroend

!macro customUnInstall
  DetailPrint "Removing Windows Firewall rule for Ez Phone Share..."
  nsExec::Exec '"$SYSDIR\netsh.exe" advfirewall firewall delete rule name="Ez Phone Share"'
  Pop $0
!macroend
