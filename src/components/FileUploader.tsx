'use client';

import { useCallback, useState } from 'react';
import { useDialog } from '@/components/Dialog';

interface FileUploaderProps {
  onFileLoaded?: (buffer: ArrayBuffer, fileName: string) => void;
  onFilesLoaded?: (files: { buffer: ArrayBuffer; name: string }[]) => void;
  multiple?: boolean;
  inputId?: string;
}

export default function FileUploader({ onFileLoaded, onFilesLoaded, multiple = false, inputId = 'file-upload' }: FileUploaderProps) {
  const dialog = useDialog();
  const [dragging, setDragging] = useState(false);
  const [fileName, setFileName] = useState<string | null>(null);

  const readFile = (file: File): Promise<ArrayBuffer> =>
    new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = (e) => {
        if (e.target?.result) resolve(e.target.result as ArrayBuffer);
        else reject(new Error('Failed to read file'));
      };
      reader.onerror = () => reject(reader.error);
      reader.readAsArrayBuffer(file);
    });

  const handleFiles = useCallback(async (files: File[]) => {
    const validFiles = files.filter(f => f.name.endsWith('.xlsx') || f.name.endsWith('.xls'));
    if (validFiles.length === 0) {
      await dialog.alert({
        title: 'Wrong file type',
        message: 'Please drop or pick Excel files (.xlsx).',
        variant: 'error',
      });
      return;
    }

    if (multiple && onFilesLoaded) {
      const loaded = await Promise.all(validFiles.map(async f => ({
        buffer: await readFile(f),
        name: f.name,
      })));
      setFileName(`${loaded.length} file${loaded.length !== 1 ? 's' : ''} selected`);
      onFilesLoaded(loaded);
    } else if (onFileLoaded) {
      const file = validFiles[0];
      setFileName(file.name);
      const buffer = await readFile(file);
      onFileLoaded(buffer, file.name);
    }
  }, [multiple, onFileLoaded, onFilesLoaded]);

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setDragging(false);
    const files = Array.from(e.dataTransfer.files);
    if (files.length > 0) handleFiles(files);
  }, [handleFiles]);

  const handleChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files || []);
    if (files.length > 0) handleFiles(files);
  }, [handleFiles]);

  return (
    <div
      onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
      onDragLeave={() => setDragging(false)}
      onDrop={handleDrop}
      className={`border-2 border-dashed rounded-lg p-8 text-center transition-colors cursor-pointer ${
        dragging ? 'border-blue-500 bg-blue-50' : 'border-slate-300 hover:border-slate-400'
      }`}
    >
      <input
        type="file"
        accept=".xlsx,.xls"
        multiple={multiple}
        onChange={handleChange}
        className="hidden"
        id={inputId}
      />
      <label htmlFor={inputId} className="cursor-pointer">
        <div className="flex flex-col items-center gap-2">
          <svg className="w-10 h-10 text-slate-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M7 16a4 4 0 01-.88-7.903A5 5 0 1115.9 6L16 6a5 5 0 011 9.9M15 13l-3-3m0 0l-3 3m3-3v12" />
          </svg>
          {fileName ? (
            <p className="text-sm text-blue-600 font-medium">{fileName}</p>
          ) : (
            <>
              <p className="text-sm text-slate-600 font-medium">
                {multiple ? 'Drop Excel files here or click to browse' : 'Drop Excel file here or click to browse'}
              </p>
              <p className="text-xs text-slate-400">{multiple ? '.xlsx files — multiple allowed' : '.xlsx files only'}</p>
            </>
          )}
        </div>
      </label>
    </div>
  );
}
