type EditorPdfPanelProps = {
  label?: string;
  url: string;
};

export const EditorPdfPanel = ({ label, url }: EditorPdfPanelProps) => {
  return <iframe src={url} title={label || "PDF document"} />;
};
