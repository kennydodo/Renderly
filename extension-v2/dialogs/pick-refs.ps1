Add-Type -AssemblyName System.Windows.Forms
$dlg = New-Object System.Windows.Forms.OpenFileDialog
$dlg.Title = "Select reference images"
$dlg.Filter = "Image files (*.png;*.jpg;*.jpeg;*.webp)|*.png;*.jpg;*.jpeg;*.webp|All files (*.*)|*.*"
$dlg.Multiselect = $true
if ($dlg.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) {
    $dlg.FileNames | ForEach-Object { Write-Output $_ }
}
