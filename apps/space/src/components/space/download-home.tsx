import { useState } from 'react';
import { Download } from 'lucide-react';
import { Button } from '@workspace/ui/components/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@workspace/ui/components/card';
import { toast } from 'sonner';

export function DownloadHome() {
  const [isDownloading, setIsDownloading] = useState(false);
  
  const handleDownload = async () => {
    try {
      setIsDownloading(true);
      
      // Create a hidden anchor element to trigger the download
      const downloadLink = document.createElement('a');
      downloadLink.href = `${import.meta.env.VITE_API_HOST}/space/zip`;
      downloadLink.download = 'eigen-home.tar.gz'; // This will be overridden by the Content-Disposition header
      
      // Add credentials to ensure the auth cookie is sent
      downloadLink.setAttribute('download', '');
      
      // Append to body, click and remove
      document.body.appendChild(downloadLink);
      downloadLink.click();
      document.body.removeChild(downloadLink);
      
      // Show success message
      toast.success('Download started');
    } catch (error) {
      console.error('Download error:', error);
      toast.error('Failed to download your data. Please try again.');
    } finally {
      // Set a timeout to re-enable the button after a short delay
      // This gives the browser time to start the download
      setTimeout(() => {
        setIsDownloading(false);
      }, 2000);
    }
  };
  
  return (
    <div>
        <div className="space-y-4">
          <p>Download a complete archive of all your data stored in eigen.</p>
          <p className="text-sm text-muted-foreground">
            This archive includes all your files, documents, emails, and other data from your Eigen workspace.
            The download may take a few seconds to prepare depending on the size of your data.
          </p>
          
          <div className="flex justify-end">
            <Button 
              onClick={handleDownload} 
              disabled={isDownloading}
              className="w-full sm:w-auto"
            >
              <Download className="mr-2 h-4 w-4" />
              {isDownloading ? "Preparing download..." : "Download your data"}
            </Button>
          </div>
        </div>
    </div>
  );
}
