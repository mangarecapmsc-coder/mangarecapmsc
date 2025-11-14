
import React, { useState, useMemo, useRef, useEffect } from 'react';
import { textToSpeech, rewriteText } from './services/geminiService';
import { decode, pcmToWavBlob } from './utils/audioUtils';
import { Spinner } from './components/Spinner';
import { UploadIcon } from './components/icons/UploadIcon';
import { TextFileIcon } from './components/icons/TextFileIcon';
import { SpeakerIcon } from './components/icons/SpeakerIcon';
import { DownloadIcon } from './components/icons/DownloadIcon';
import { PlayIcon } from './components/icons/PlayIcon';
import { MergeIcon } from './components/icons/MergeIcon';
import { RetryIcon } from './components/icons/RetryIcon';
import { SheetIcon } from './components/icons/SheetIcon';

// Add this line to inform TypeScript about the global JSZip variable from the script tag
declare const JSZip: any;

type LineStatus = 'pending' | 'converting' | 'done' | 'error';
type FileStatus = 'pending' | 'converting' | 'done' | 'error';
type PreviewStatus = 'idle' | 'fetching' | 'playing';


interface ParsedLine {
  id: string;
  text: string;
  status: LineStatus;
  audioData?: string;
  error?: string;
  startTimeMs?: number;
  endTimeMs?: number;
}

interface FileState {
  id: string; // unique identifier for the file batch
  file: File;
  name: string;
  status: FileStatus;
  lines: ParsedLine[];
  error?: string; // For file-level errors like parsing
  isZipping?: boolean;
  isMerging?: boolean;
}

const VOICES = [
  // Popular voices
  { id: 'Puck', name: 'Puck (Male)' },
  { id: 'Charon', name: 'Charon (Male, Deep)' },
  { id: 'Kore', name: 'Kore (Female)' },
  { id: 'Fenrir', name: 'Fenrir (Male)' },
  // Other recognized voices
  { id: 'Zephyr', name: 'Zephyr (Female)' },
  { id: 'Leda', name: 'Leda' },
  { id: 'Orus', name: 'Orus' },
  { id: 'Aoede', name: 'Aoede' },
  { id: 'Callirhoe', name: 'Callirhoe' },
  { id: 'Autonoe', name: 'Autonoe' },
  { id: 'Enceladus', name: 'Enceladus' },
  { id: 'Iapetus', name: 'Iapetus' },
  { id: 'Umbriel', name: 'Umbriel' },
  { id: 'Algieba', name: 'Algieba' },
  { id: 'Despina', name: 'Despina' },
  { id: 'Erinome', name: 'Erinome' },
  { id: 'Algenib', name: 'Algenib' },
  { id: 'Rasalgethi', name: 'Rasalgethi' },
  { id: 'Laomedeia', name: 'Laomedeia' },
  { id: 'Achernar', name: 'Achernar' },
  { id: 'Alnilam', name: 'Alnilam' },
  // Retaining previously available voices not in the image for completeness
  { id: 'Aura', name: 'Aura (Female)' },
  { id: 'Eos', name: 'Eos (Male)' },
];

const WarningIcon: React.FC = () => (
    <svg xmlns="http://www.w3.org/2000/svg" className="h-6 w-6 text-yellow-400 flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
        <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
    </svg>
);

/**
 * Parses an SRT timestamp string (HH:MM:SS,ms) into milliseconds.
 * @param timestamp The timestamp string.
 * @returns Total milliseconds.
 */
const parseSrtTimestamp = (timestamp: string): number => {
    const parts = timestamp.split(',');
    if (parts.length !== 2) return 0;
    const [hms, ms] = parts;
    const [h, m, s] = hms.split(':').map(Number);
    if (isNaN(h) || isNaN(m) || isNaN(s) || isNaN(Number(ms))) return 0;
    return (h * 3600 + m * 60 + s) * 1000 + Number(ms);
};

/**
 * Parses content from an SRT (subtitle) file, including timestamps.
 * @param content The string content of the SRT file.
 * @returns An array of objects with id, text, startTimeMs, and endTimeMs.
 */
const parseSrt = (content: string): { id: string; text: string; startTimeMs: number; endTimeMs: number; }[] => {
    const blocks = content.trim().replace(/\r/g, '').split('\n\n');
    return blocks.map(block => {
        const lines = block.split('\n');
        if (lines.length < 2) return null;
        
        const id = lines[0];
        const timestampLine = lines[1];
        const timestamps = timestampLine.split(' --> ');

        // Check if the second line is a timestamp to be more robust
        if (timestamps.length !== 2 || !/^\d+$/.test(id)) return null;

        const startTimeMs = parseSrtTimestamp(timestamps[0].trim());
        const endTimeMs = parseSrtTimestamp(timestamps[1].trim());
        
        const text = lines.slice(2).join(' ').replace(/<[^>]*>?/gm, '').trim();
        
        if (!id.trim() || !text) return null;

        return { id: id.trim(), text, startTimeMs, endTimeMs };
    }).filter((item): item is { id: string; text: string; startTimeMs: number; endTimeMs: number; } => item !== null);
};


/**
 * Parses content from a TXT file, automatically detecting if it's
 * in "id;text" format or just plain text.
 * @param content The string content of the TXT file.
 * @returns An array of objects with id and text.
 */
const parseTxt = (content: string): { id: string, text: string }[] => {
    const lines = content.trim().replace(/\r/g, '').split('\n').filter(line => line.trim() !== '');
    if (lines.length === 0) return [];

    let isIdTextFormat = true;
    const potentialIdText = lines.map(line => {
        const parts = line.split(';');
        if (parts.length < 2 || !parts[0].trim() || !parts[1].trim()) {
            isIdTextFormat = false;
        }
        return {
            id: parts[0].trim(),
            text: parts.slice(1).join(';').trim()
        };
    });
    
    if (isIdTextFormat) {
        return potentialIdText;
    }

    // Fallback to plain text format, creating a zero-padded ID for sorting
    return lines.map((line, index) => ({
        id: String(index + 1).padStart(3, '0'),
        text: line.trim()
    }));
};

const getStatusIndicator = (status: LineStatus) => {
    switch (status) {
        case 'pending': return <span className="text-xs font-semibold text-slate-500">PENDING</span>;
        case 'converting': 
            return (
                <span className="text-xs font-semibold text-yellow-400 flex items-center gap-1.5">
                    <svg className="animate-spin h-3 w-3" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
                        <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
                        <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
                    </svg>
                    CONVERTING
                </span>
            );
        case 'done': return <span className="text-xs font-semibold text-green-400">DONE</span>;
        case 'error': return <span className="text-xs font-semibold text-red-400">ERROR</span>;
    }
}

interface FileCardProps {
  file: FileState;
  onConvert: (fileId: string) => void;
  onDownload: (fileId: string) => void;
  onDownloadMerged: (fileId: string) => void;
  onRemove: (fileId: string) => void;
  onRetryLine: (fileId: string, lineId: string) => void;
  isActionLocked: boolean;
}

const FileCard: React.FC<FileCardProps> = ({ file, onConvert, onDownload, onDownloadMerged, onRemove, onRetryLine, isActionLocked }) => {
    const conversionStats = useMemo(() => {
        if (!file.lines) return { total: 0, done: 0, error: 0, progress: 0 };
        const total = file.lines.length;
        const done = file.lines.filter(l => l.status === 'done').length;
        const error = file.lines.filter(l => l.status === 'error').length;
        const progress = total > 0 ? ((done + error) / total) * 100 : 0;
        return { total, done, error, progress };
    }, [file.lines]);

    const isFinished = file.status === 'done' || file.status === 'error';
    const hasSuccessfulFiles = conversionStats.done > 0;
    const isSrtFile = file.name.toLowerCase().endsWith('.srt');

    return (
        <div className="bg-slate-800 rounded-lg shadow-xl p-4 md:p-6 space-y-4">
            <div className="flex items-center justify-between">
                <div className="flex items-center gap-3 min-w-0">
                    <TextFileIcon />
                    <div className='flex flex-col min-w-0'>
                        <span className="font-medium text-slate-300 truncate" title={file.name}>{file.name}</span>
                        <span className='text-sm text-slate-400'>{file.lines.length} lines detected</span>
                    </div>
                </div>
                <button onClick={() => onRemove(file.id)} className="text-sm font-semibold text-slate-400 hover:text-white disabled:text-slate-600 disabled:cursor-not-allowed" disabled={isActionLocked}>&times; Remove</button>
            </div>
            
            {file.error && <div className="bg-red-900/50 border border-red-500 text-red-300 px-4 py-3 rounded-md text-sm">{file.error}</div>}

            {!isFinished ? (
                <button
                    onClick={() => onConvert(file.id)}
                    disabled={isActionLocked}
                    className="w-full flex items-center justify-center gap-2 bg-sky-600 hover:bg-sky-500 disabled:bg-slate-600 disabled:cursor-not-allowed text-white font-bold py-2 px-6 rounded-lg shadow-lg transition-all"
                >
                    {file.status === 'converting' ? (
                        <>
                            <Spinner />
                            <span>Converting...</span>
                        </>
                    ) : (
                        <>
                            <SpeakerIcon />
                            <span>Start Conversion</span>
                        </>
                    )}
                </button>
            ) : (
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                    <button
                        onClick={() => onDownload(file.id)}
                        disabled={file.isZipping || file.isMerging || !hasSuccessfulFiles}
                        className="w-full flex items-center justify-center gap-2 bg-green-600 hover:bg-green-500 disabled:bg-slate-600 disabled:cursor-not-allowed text-white font-bold py-2 px-6 rounded-lg shadow-lg transition-all"
                    >
                        {file.isZipping ? (
                        <>
                            <Spinner />
                            <span>Zipping...</span>
                        </>
                        ) : (
                        <>
                            <DownloadIcon />
                            <span>Download ZIP ({conversionStats.done} files)</span>
                        </>
                        )}
                    </button>
                    <button
                        onClick={() => onDownloadMerged(file.id)}
                        disabled={file.isZipping || file.isMerging || !hasSuccessfulFiles}
                        className="w-full flex items-center justify-center gap-2 bg-indigo-600 hover:bg-indigo-500 disabled:bg-slate-600 disabled:cursor-not-allowed text-white font-bold py-2 px-6 rounded-lg shadow-lg transition-all"
                    >
                        {file.isMerging ? (
                        <>
                            <Spinner />
                            <span>Merging...</span>
                        </>
                        ) : (
                        <>
                            <MergeIcon />
                            <span>{isSrtFile ? 'Download Merged (SRT Timed)' : 'Download Merged File'}</span>
                        </>
                        )}
                    </button>
                </div>
            )}

            {(file.status === 'converting' || isFinished) && (
                <div className="w-full bg-slate-700 rounded-full h-2.5">
                    <div className="bg-sky-500 h-2.5 rounded-full transition-all duration-300" style={{ width: `${conversionStats.progress}%` }}></div>
                </div>
            )}
            
            {(file.status === 'converting' || isFinished) && (
                 <div className="bg-slate-900/70 p-3 rounded-md max-h-80 overflow-y-auto space-y-2">
                    {file.lines.map(line => (
                        <div key={line.id} className="text-sm p-2 bg-slate-800/50 rounded">
                           <div className="grid grid-cols-[auto_1fr_auto] items-center gap-3">
                                <span className='font-mono text-slate-500 w-10 text-right'>{line.id}</span>
                                <p className={`text-slate-300 ${line.status !== 'error' ? 'truncate' : ''}`} title={line.text}>{line.text}</p>
                                <div className="flex items-center gap-2 justify-end">
                                   {getStatusIndicator(line.status)}
                                   {line.status === 'error' && (
                                       <button
                                           onClick={() => onRetryLine(file.id, line.id)}
                                           title="Retry conversion for this line"
                                           className="text-sky-400 hover:text-sky-300 disabled:text-slate-600"
                                           disabled={isActionLocked}
                                       >
                                           <RetryIcon className="h-4 w-4" />
                                       </button>
                                   )}
                                </div>
                           </div>
                           {line.status === 'error' && line.error && (
                                <div className="pl-14 pt-1 text-xs text-red-400">
                                    <p><strong>Reason:</strong> {line.error.replace('Failed to convert text to speech: ', '')}</p>
                                </div>
                           )}
                        </div>
                    ))}
                </div>
            )}
        </div>
    );
}


const App: React.FC = () => {
  const [files, setFiles] = useState<FileState[]>([]);
  const [selectedVoice, setSelectedVoice] = useState<string>(() => localStorage.getItem('tts-selectedVoice') || VOICES[0].id);
  const [previewText, setPreviewText] = useState<string>('Hello! This is a preview of the selected voice.');
  const [voicePrompt, setVoicePrompt] = useState<string>(() => localStorage.getItem('tts-voicePrompt') || '');
  const [savedPrompts, setSavedPrompts] = useState<string[]>(() => {
    const saved = localStorage.getItem('tts-saved-prompts');
    return saved ? JSON.parse(saved) : [];
  });
  const [convertingFileId, setConvertingFileId] = useState<string | null>(null);
  const [isBatchConvertingAll, setIsBatchConvertingAll] = useState<boolean>(false);
  const [isImportingPrompts, setIsImportingPrompts] = useState<boolean>(false);
  const [globalError, setGlobalError] = useState<string | null>(null);
  const [previewStatus, setPreviewStatus] = useState<PreviewStatus>('idle');
  const [apiKey, setApiKey] = useState<string>(() => localStorage.getItem('gemini-api-key') || '');
  const [isKeySaved, setIsKeySaved] = useState<boolean>(() => !!localStorage.getItem('gemini-api-key'));
  const fileInputRef = useRef<HTMLInputElement>(null);

  const RETRY_ATTEMPTS = 5;
  const RETRY_DELAY_MS = 2000;
  const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

  // Effect to save settings to localStorage
  useEffect(() => {
    localStorage.setItem('tts-selectedVoice', selectedVoice);
    localStorage.setItem('tts-voicePrompt', voicePrompt);
  }, [selectedVoice, voicePrompt]);

  useEffect(() => {
    localStorage.setItem('tts-saved-prompts', JSON.stringify(savedPrompts));
  }, [savedPrompts]);

  const handleSaveKey = () => {
    if (apiKey.trim()) {
      localStorage.setItem('gemini-api-key', apiKey.trim());
      setIsKeySaved(true);
    }
  };

  const handleEditKey = () => {
    setIsKeySaved(false);
  };

  const constructApiText = (baseText: string): string => {
    // The `voicePrompt` is prepended to the base text. This is the standard method
    // for providing instructions like tone or emotion to the TTS model.
    // The model will automatically detect the language of the text.
    const textWithPrompt = voicePrompt ? `${voicePrompt} ${baseText}` : baseText;
    return textWithPrompt;
  };

  const handleFileChange = (event: React.ChangeEvent<HTMLInputElement>) => {
    const newFiles = event.target.files ? Array.from(event.target.files) : [];
    if (newFiles.length === 0) return;

    setGlobalError(null);

    newFiles.forEach((file: File) => {
        if (files.some(f => f.name === file.name && f.file.lastModified === file.lastModified)) {
            return; // Skip duplicates
        }

        const reader = new FileReader();
        reader.onload = (e) => {
            const text = e.target?.result as string;
            try {
                // FIX: Correctly type the `parsed` variable. The parsing functions return objects without
                // the `status` field, which was causing a type error. The `status` is added below when
                // creating the `newFileState`.
                let parsed: { id: string; text: string; startTimeMs?: number; endTimeMs?: number }[] = [];
                const fileExtension = file.name.split('.').pop()?.toLowerCase();

                if (fileExtension === 'srt') parsed = parseSrt(text);
                else if (fileExtension === 'txt') parsed = parseTxt(text);
                else throw new Error(`Unsupported file type: .${fileExtension}`);

                if (parsed.length === 0) throw new Error("Could not find any text to convert.");

                const newFileState: FileState = {
                    id: `${file.name}-${file.lastModified}`,
                    file,
                    name: file.name,
                    status: 'pending',
                    lines: parsed.map(line => ({ ...line, status: 'pending' })),
                };
                setFiles(prev => [...prev, newFileState]);
            } catch (parseError: any) {
                setGlobalError(`Error in ${file.name}: ${parseError.message}`);
            }
        };
        reader.onerror = () => {
            setGlobalError(`Failed to read the file: ${file.name}`);
        };
        reader.readAsText(file);
    });

    // Reset file input to allow re-uploading the same file after removing
    if(event.target) event.target.value = '';
  };

  const handleRemoveFile = (fileId: string) => {
      setFiles(prev => prev.filter(f => f.id !== fileId));
  }

  const convertLineWithRetries = async (fileId: string, line: ParsedLine) => {
    setFiles(prev => prev.map(f => {
        if (f.id !== fileId) return f;
        const updatedLines = f.lines.map(l => l.id === line.id ? { ...l, status: 'converting' as const, error: undefined } : l);
        return { ...f, lines: updatedLines };
    }));
    
    let textToProcess = line.text;
    let hasBeenRewritten = false;

    for (let attempt = 1; attempt <= RETRY_ATTEMPTS; attempt++) {
        try {
            const textToSend = constructApiText(textToProcess);
            const audioData = await textToSpeech(textToSend, selectedVoice, apiKey);
            
            setFiles(prev => prev.map(f => {
                if (f.id !== fileId) return f;
                const updatedLines = f.lines.map(l => l.id === line.id ? { ...l, status: 'done' as const, audioData, text: textToProcess } : l);
                return { ...f, lines: updatedLines };
            }));
            return; // Success!
        } catch (err: any) {
            console.error(`Attempt ${attempt} failed for line ${line.id}:`, err);

            // If it's a content block error and we haven't rewritten yet, try to rewrite.
            if (err.message.includes('Content blocked') && !hasBeenRewritten) {
                hasBeenRewritten = true; // Mark that we are attempting a rewrite
                try {
                    console.log(`Content blocked for line ${line.id}. Rewriting...`);
                    // Update UI to show rewriting status
                    setFiles(prev => prev.map(f => {
                        if (f.id !== fileId) return f;
                        const updatedLines = f.lines.map(l => l.id === line.id ? { ...l, error: 'Content blocked. Attempting to rewrite...' } : l);
                        return { ...f, lines: updatedLines };
                    }));
                    
                    const rewrittenText = await rewriteText(textToProcess, apiKey);
                    textToProcess = rewrittenText; // Use the new text for subsequent attempts
                    
                    console.log(`Retrying with rewritten text: "${rewrittenText}"`);
                    // Update UI with new text and clear the temporary error
                     setFiles(prev => prev.map(f => {
                        if (f.id !== fileId) return f;
                        const updatedLines = f.lines.map(l => l.id === line.id ? { ...l, text: rewrittenText, error: undefined } : l);
                        return { ...f, lines: updatedLines };
                    }));

                    // Go to the next iteration immediately with the new text
                    continue; 
                } catch (rewriteError: any) {
                    console.error(`Failed to rewrite text for line ${line.id}:`, rewriteError);
                    // If rewriting fails, we'll fall through and let the normal retry/failure logic handle it.
                }
            }

            if (attempt < RETRY_ATTEMPTS) {
                await delay(RETRY_DELAY_MS);
            } else {
                // Final attempt failed
                setFiles(prev => prev.map(f => {
                    if (f.id !== fileId) return f;
                    const finalError = hasBeenRewritten 
                      ? `The rewritten text was also blocked or failed. Last error: ${err.message}` 
                      : err.message;
                    const updatedLines = f.lines.map(l => l.id === line.id ? { ...l, status: 'error' as const, error: finalError, text: textToProcess } : l);
                    return { ...f, lines: updatedLines };
                }));
            }
        }
    }
};

  const handleRetryLine = async (fileId: string, lineId: string) => {
    if (!isKeySaved) return;
    const file = files.find(f => f.id === fileId);
    const line = file?.lines.find(l => l.id === lineId);

    if (!file || !line || convertingFileId || isBatchConvertingAll) return;

    await convertLineWithRetries(fileId, line);

    setFiles(prev => prev.map(f => {
        if (f.id !== fileId) return f;
        const doneCount = f.lines.filter(l => l.status === 'done').length;
        const errorCount = f.lines.filter(l => l.status === 'error').length;
        if ((doneCount + errorCount) === f.lines.length) {
            return { ...f, status: 'done' };
        }
        return f;
    }));
  };

  const handleBatchConvert = async (fileId: string) => {
    if (!isKeySaved) return;
    const fileToConvert = files.find(f => f.id === fileId);
    if (!fileToConvert) {
        return;
    }
    
    setConvertingFileId(fileId);
    setFiles(prev => prev.map(f => f.id === fileId ? { ...f, status: 'converting' } : f));

    const conversionPromises = fileToConvert.lines.map(line => convertLineWithRetries(fileId, line));

    await Promise.allSettled(conversionPromises);
    setFiles(prev => prev.map(f => f.id === fileId ? { ...f, status: 'done' } : f));
    setConvertingFileId(null);
  };
  
  const handleGenerateAll = async () => {
    if (!isKeySaved) return;
    setIsBatchConvertingAll(true);
    const filesToConvert = files.filter(f => f.status === 'pending');
    for (const file of filesToConvert) {
        await handleBatchConvert(file.id);
    }
    setIsBatchConvertingAll(false);
  };

  const handleExportSettings = () => {
    try {
        const settings = {
            selectedVoice,
            voicePrompt,
            savedPrompts,
        };
        const blob = new Blob([JSON.stringify(settings, null, 2)], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = 'tts-converter-settings.json';
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
    } catch (error) {
        setGlobalError("Failed to export settings.");
        console.error("Export failed:", error);
    }
  };
  
  const handleLoadPromptsFromSheet = async () => {
      setIsImportingPrompts(true);
      setGlobalError(null);
      // This URL is constructed to directly export the Google Sheet as a CSV file.
      // A timestamp is added as a cache-busting parameter to ensure the latest data is fetched.
      const sheetUrl = `https://docs.google.com/spreadsheets/d/1z1dLvL3SgMFjz6TLP-VVUemYd6TlXJpOq2RsqOTxD84/export?format=csv&gid=0&t=${Date.now()}`;

      try {
          const response = await fetch(sheetUrl);
          if (!response.ok) {
              throw new Error(`The Google Sheet may not be public. (Status: ${response.status})`);
          }
          const csvText = await response.text();
          
          // Each line in the CSV is treated as a single prompt.
          const newPrompts = csvText
              .trim()
              .replace(/\r/g, '') // Remove carriage returns
              .split('\n')
              .map(row => row.trim().replace(/^"(.*)"$/, '$1')) // Treat each row as a single prompt
              .filter(prompt => prompt !== ''); // Remove any empty prompts

          if (newPrompts.length === 0) {
              throw new Error("No prompts were found in the Google Sheet.");
          }

          setSavedPrompts(prev => {
              // Use a Set to automatically handle duplicates when merging
              const combined = new Set([...prev, ...newPrompts]);
              return Array.from(combined).sort();
          });

      } catch (error: any) {
          console.error("Failed to load prompts from Google Sheet:", error);
          setGlobalError(`Failed to load prompts from sheet: ${error.message}`);
      } finally {
          setIsImportingPrompts(false);
      }
  };

  const handlePreviewVoice = async () => {
    if (!isKeySaved) return;
    if (!previewText.trim()) {
        setGlobalError("Please enter some text to preview.");
        return;
    }
    setPreviewStatus('fetching');
    setGlobalError(null);
    try {
        const textToSend = constructApiText(previewText);
        const audioData = await textToSpeech(textToSend, selectedVoice, apiKey);
        const pcmBytes = decode(audioData);
        const wavBlob = pcmToWavBlob(pcmBytes);
        const audioUrl = window.URL.createObjectURL(wavBlob);
        const audio = new Audio(audioUrl);

        audio.onplaying = () => setPreviewStatus('playing');
        audio.onended = () => {
            setPreviewStatus('idle');
            window.URL.revokeObjectURL(audioUrl);
        };
        audio.onerror = () => {
            setGlobalError("Error playing audio preview.");
            setPreviewStatus('idle');
            window.URL.revokeObjectURL(audioUrl);
        };
        
        audio.play();
    } catch (err: any) {
        setGlobalError(`Failed to fetch voice preview: ${err.message}`);
        setPreviewStatus('idle');
    }
  };

  const handleDownloadSrtMerged = async (fileId: string) => {
    const fileToMerge = files.find(f => f.id === fileId);
    if (!fileToMerge) return;

    setFiles(prev => prev.map(f => f.id === fileId ? { ...f, isMerging: true } : f));
    setGlobalError(null);

    try {
        const successfulLines = fileToMerge.lines.filter(line => line.status === 'done' && line.audioData && line.endTimeMs !== undefined);
        if (successfulLines.length === 0) {
          throw new Error("No successful audio files to merge for this SRT.");
        }

        const lastEndTimeMs = Math.max(...successfulLines.map(line => line.endTimeMs!));
        const totalDurationMs = lastEndTimeMs + 2000; // Add 2s buffer for safety

        const sampleRate = 24000;
        const bitsPerSample = 16;
        const numChannels = 1;
        const bytesPerSample = bitsPerSample / 8;
        const bytesPerSecond = sampleRate * numChannels * bytesPerSample;
        const totalBytes = Math.ceil((totalDurationMs / 1000) * bytesPerSecond);
        
        const finalTotalBytes = totalBytes % 2 === 0 ? totalBytes : totalBytes + 1;
        const mergedPcm = new Uint8Array(finalTotalBytes).fill(0);

        for (const line of successfulLines) {
            if (!line.audioData || line.startTimeMs === undefined) continue;

            const audioChunk = decode(line.audioData);
            const startByte = (line.startTimeMs / 1000) * bytesPerSecond;

            if (startByte + audioChunk.length <= mergedPcm.length) {
                mergedPcm.set(audioChunk, startByte);
            } else {
                const truncatedChunk = audioChunk.slice(0, mergedPcm.length - startByte);
                mergedPcm.set(truncatedChunk, startByte);
                console.warn(`Audio for line ${line.id} was truncated.`);
            }
        }
        
        const wavBlob = pcmToWavBlob(mergedPcm);
        const link = document.createElement('a');
        const baseName = fileToMerge.name.replace(/\.[^/.]+$/, "");
        link.href = window.URL.createObjectURL(wavBlob);
        link.download = `${baseName}_timed_merged.wav`;
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
        window.URL.revokeObjectURL(link.href);
    } catch (err: any) {
        console.error("SRT Merging failed:", err);
        setGlobalError(`Failed to merge audio for ${fileToMerge.name}: ${err.message}`);
    } finally {
        setFiles(prev => prev.map(f => f.id === fileId ? { ...f, isMerging: false } : f));
    }
  };

  const handleDownloadConcatMerged = async (fileId: string) => {
    const fileToMerge = files.find(f => f.id === fileId);
    if (!fileToMerge) return;

    setFiles(prev => prev.map(f => f.id === fileId ? { ...f, isMerging: true } : f));
    setGlobalError(null);

    try {
        const successfulLines = fileToMerge.lines.filter(line => line.status === 'done' && line.audioData);
        if (successfulLines.length === 0) {
          throw new Error("No successful audio files to merge.");
        }

        const pcmChunks: Uint8Array[] = successfulLines.map(line => decode(line.audioData!));

        const totalLength = pcmChunks.reduce((acc, chunk) => acc + chunk.length, 0);
        const mergedPcm = new Uint8Array(totalLength);
        let offset = 0;
        for (const chunk of pcmChunks) {
            mergedPcm.set(chunk, offset);
            offset += chunk.length;
        }

        const wavBlob = pcmToWavBlob(mergedPcm);
        const link = document.createElement('a');
        const baseName = fileToMerge.name.replace(/\.[^/.]+$/, "");
        link.href = window.URL.createObjectURL(wavBlob);
        link.download = `${baseName}_merged.wav`;
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
        window.URL.revokeObjectURL(link.href);
    } catch (err: any) {
        console.error("Merging failed:", err);
        setGlobalError(`Failed to merge audio for ${fileToMerge.name}: ${err.message}`);
    } finally {
        setFiles(prev => prev.map(f => f.id === fileId ? { ...f, isMerging: false } : f));
    }
  };

  const handleDownloadMerged = (fileId: string) => {
    const file = files.find(f => f.id === fileId);
    if (!file) return;

    if (file.name.toLowerCase().endsWith('.srt')) {
        handleDownloadSrtMerged(fileId);
    } else {
        handleDownloadConcatMerged(fileId);
    }
  };

  const handleDownloadZip = async (fileId: string) => {
    const fileToZip = files.find(f => f.id === fileId);
    if (!fileToZip) return;

    const successfulLines = fileToZip.lines.filter(line => line.status === 'done' && line.audioData);
    if (successfulLines.length === 0) {
      setGlobalError("No audio files were successfully generated to download for this file.");
      return;
    }

    setFiles(prev => prev.map(f => f.id === fileId ? { ...f, isZipping: true } : f));
    setGlobalError(null);

    try {
      const zip = new JSZip();
      const folderName = fileToZip.name.replace(/\.[^/.]+$/, ""); // remove extension
      const folder = zip.folder(folderName);
      if (!folder) throw new Error("Could not create a folder in the zip file.");

      for (const line of successfulLines) {
        if(line.audioData) {
            const pcmBytes = decode(line.audioData);
            const wavBlob = pcmToWavBlob(pcmBytes);
            folder.file(`${line.id}.wav`, wavBlob);
        }
      }

      const zipBlob = await zip.generateAsync({ type: 'blob' });
      const link = document.createElement('a');
      link.href = window.URL.createObjectURL(zipBlob);
      link.download = `${folderName}.zip`;
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      window.URL.revokeObjectURL(link.href);
    } catch (err: any) {
      console.error("Zipping failed:", err);
      setGlobalError(`Failed to create ZIP file for ${fileToZip.name}: ${err.message}`);
    } finally {
      setFiles(prev => prev.map(f => f.id === fileId ? { ...f, isZipping: false } : f));
    }
  };
  
  const handleSavePrompt = () => {
    const trimmedPrompt = voicePrompt.trim();
    if (trimmedPrompt && !savedPrompts.includes(trimmedPrompt)) {
        setSavedPrompts(prev => [...prev, trimmedPrompt].sort());
    }
  };

  const handleDeletePrompt = (promptToDelete: string) => {
    setSavedPrompts(prev => prev.filter(p => p !== promptToDelete));
  };


  const isConvertingAny = !!convertingFileId || isBatchConvertingAll;
  const isActionLocked = isConvertingAny || !isKeySaved;

  return (
    <div className="min-h-screen bg-slate-900 flex flex-col items-center p-4 sm:p-6 font-sans">
      <div className="w-full max-w-3xl mx-auto">
        <header className="text-center mb-8">
          <h1 className="text-4xl md:text-5xl font-bold text-sky-400">Text to Speech Batch Converter</h1>
          <p className="text-slate-400 mt-2">Upload `.txt` or `.srt` files, configure voice settings, and convert each line to speech.</p>
        </header>

        <main className="space-y-6">
            {isKeySaved ? (
                <div className="bg-slate-800/50 border border-slate-700 text-slate-300 px-4 py-3 rounded-lg">
                    <div className="flex items-center justify-between gap-3">
                        <div className="flex items-center gap-3">
                            <svg xmlns="http://www.w3.org/2000/svg" className="h-6 w-6 text-green-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                                <path strokeLinecap="round" strokeLinejoin="round" d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
                            </svg>
                            <div>
                                <h3 className="text-md font-bold text-green-400">API Key is Configured</h3>
                                <p className="text-sm text-slate-400 mt-1">
                                    The application is ready to make requests.
                                </p>
                            </div>
                        </div>
                        <button onClick={handleEditKey} className="text-sm font-semibold bg-slate-600 hover:bg-slate-500 text-white py-1 px-3 rounded-md">
                            Change Key
                        </button>
                    </div>
                </div>
            ) : (
                <div className="bg-sky-900/50 border border-sky-500 text-sky-300 px-4 py-3 rounded-lg space-y-2">
                    <div className="flex items-start gap-3">
                        <WarningIcon />
                        <div>
                            <h3 className="text-lg font-bold">Enter Your Gemini API Key</h3>
                            <p className="text-sm mt-1">
                                To use this application, please enter your Google Gemini API key below. Your key is stored only in your browser's local storage.
                            </p>
                            <div className="flex gap-2 mt-3">
                                <input
                                    type="password"
                                    value={apiKey}
                                    onChange={(e) => setApiKey(e.target.value)}
                                    placeholder="Enter your API key"
                                    className="flex-grow w-full bg-slate-900/50 border border-slate-600 rounded-md py-2 px-3 text-white focus:ring-sky-500 focus:border-sky-500"
                                />
                                <button
                                    onClick={handleSaveKey}
                                    disabled={!apiKey.trim()}
                                    className="bg-sky-600 hover:bg-sky-500 disabled:bg-slate-600 disabled:cursor-not-allowed text-white font-bold py-2 px-4 rounded-lg"
                                >
                                    Save Key
                                </button>
                            </div>
                            <p className="text-xs text-slate-500 mt-2">
                                You can get your API key from <a href="https://aistudio.google.com/app/apikey" target="_blank" rel="noopener noreferrer" className="underline hover:text-sky-400">Google AI Studio</a>.
                            </p>
                        </div>
                    </div>
                </div>
            )}


            <div className='flex flex-col gap-4 bg-slate-800 rounded-lg shadow-2xl p-6'>
                <div>
                    <label htmlFor="voice-prompt" className="block text-sm font-medium text-slate-400 mb-1">
                        Voice Prompt <span className="text-slate-500">(Optional)</span>
                    </label>
                    <div className="flex items-center gap-2">
                        <input
                            id="voice-prompt"
                            type="text"
                            value={voicePrompt}
                            onChange={(e) => setVoicePrompt(e.target.value)}
                            placeholder="e.g., Say cheerfully:, Announce dramatically:"
                            disabled={isActionLocked}
                            className="flex-grow w-full bg-slate-700 border border-slate-600 rounded-md py-2 px-3 text-white focus:ring-sky-500 focus:border-sky-500 disabled:bg-slate-700/50"
                            aria-describedby="voice-prompt-description"
                        />
                         <button
                            type="button"
                            onClick={handleSavePrompt}
                            disabled={isActionLocked || !voicePrompt.trim() || savedPrompts.includes(voicePrompt.trim())}
                            title="Save the current prompt for future use"
                            className="flex-shrink-0 bg-indigo-600 hover:bg-indigo-500 disabled:bg-slate-700 disabled:text-slate-400 disabled:cursor-not-allowed text-white font-bold py-2 px-4 rounded-lg shadow-lg transition-all"
                        >
                            Save
                        </button>
                    </div>
                     <p id="voice-prompt-description" className="text-xs text-slate-500 mt-1">
                        Add instructions to guide the voice's tone and emotion (e.g., "Whisper:", "Shout:", "Speak with a sad tone:").
                     </p>
                     {savedPrompts.length > 0 && (
                        <div className="mt-4">
                            <h4 className="text-xs font-semibold uppercase text-slate-500 mb-2">Saved Prompts</h4>
                            <div className="flex flex-wrap gap-2">
                                {savedPrompts.map((prompt, index) => (
                                    <div key={index} className="flex items-center bg-slate-700 rounded-full text-sm group">
                                        <button 
                                            onClick={() => setVoicePrompt(prompt)}
                                            className="px-3 py-1 text-slate-300 hover:text-white transition-colors"
                                            title={`Use prompt: "${prompt}"`}
                                            disabled={isActionLocked}
                                        >
                                            {prompt}
                                        </button>
                                        <button
                                            onClick={() => handleDeletePrompt(prompt)}
                                            className="pr-2 pl-1 text-slate-500 hover:text-red-400 opacity-50 group-hover:opacity-100 transition-all"
                                            title={`Delete prompt: "${prompt}"`}
                                            aria-label={`Delete prompt: "${prompt}"`}
                                            disabled={isActionLocked}
                                        >
                                            <svg xmlns="http://www.w3.org/2000/svg" className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                                                <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                                            </svg>
                                        </button>
                                    </div>
                                ))}
                            </div>
                        </div>
                    )}
                </div>
                <div className='space-y-4'>
                    <div>
                        <label htmlFor="voice-select" className="block text-sm font-medium text-slate-400 mb-1">Voice</label>
                        <select
                            id="voice-select"
                            value={selectedVoice}
                            onChange={(e) => setSelectedVoice(e.target.value)}
                            disabled={isActionLocked || previewStatus !== 'idle'}
                            className="w-full bg-slate-700 border border-slate-600 rounded-md py-2 px-3 text-white focus:ring-sky-500 focus:border-sky-500 disabled:bg-slate-700/50"
                        >
                        {VOICES.map(voice => (
                            <option key={voice.id} value={voice.id}>{voice.name}</option>
                        ))}
                        </select>
                    </div>
                </div>
                 <div>
                    <label htmlFor="preview-text" className="block text-sm font-medium text-slate-400 mb-1">
                        Preview Text
                    </label>
                    <div className="flex items-center gap-2">
                    <textarea
                        id="preview-text"
                        rows={2}
                        value={previewText}
                        onChange={(e) => setPreviewText(e.target.value)}
                        placeholder="Enter text to preview..."
                        disabled={isActionLocked || previewStatus !== 'idle'}
                        className="flex-grow w-full bg-slate-700 border border-slate-600 rounded-md py-2 px-3 text-white focus:ring-sky-500 focus:border-sky-500 disabled:bg-slate-700/50"
                    />
                    <button
                        type="button"
                        onClick={handlePreviewVoice}
                        disabled={isActionLocked || previewStatus !== 'idle'}
                        title="Preview voice with current settings"
                        className="flex-shrink-0 w-11 h-11 flex items-center justify-center bg-sky-600 hover:bg-sky-500 disabled:bg-slate-700 disabled:cursor-not-allowed text-white font-bold rounded-lg shadow-lg transition-all"
                        aria-label="Preview Voice"
                    >
                        {previewStatus === 'idle' && <PlayIcon />}
                        {previewStatus === 'fetching' && <Spinner />}
                        {previewStatus === 'playing' && <SpeakerIcon />}
                    </button>
                    </div>
                </div>
                <div className="border-t border-slate-700 pt-4 space-y-4">
                    <button
                        onClick={() => fileInputRef.current?.click()}
                        disabled={isActionLocked}
                        className="w-full flex items-center justify-center gap-2 bg-slate-600 hover:bg-slate-500 disabled:bg-slate-700 disabled:cursor-not-allowed text-white font-bold py-2 px-6 rounded-lg shadow-lg transition-all"
                    >
                        <UploadIcon />
                        <span>{files.length > 0 ? 'Add More Files' : 'Upload Files'}</span>
                    </button>
                    <input ref={fileInputRef} id="file-upload" name="file-upload" type="file" className="sr-only" accept=".txt,.srt" onChange={handleFileChange} multiple />
                    <div className="flex justify-center items-center gap-2 flex-wrap">
                        <button
                            onClick={handleExportSettings}
                            disabled={isActionLocked}
                            className="flex items-center gap-2 text-sm bg-slate-700 hover:bg-slate-600 disabled:bg-slate-700/50 disabled:cursor-not-allowed text-slate-300 font-semibold py-2 px-4 rounded-md transition-all"
                            title="Export current settings to a .json file"
                        >
                            <DownloadIcon className="h-4 w-4" />
                            <span>Export</span>
                        </button>
                        <button
                            onClick={handleLoadPromptsFromSheet}
                            disabled={isActionLocked || isImportingPrompts}
                            className="flex items-center justify-center gap-2 text-sm bg-slate-700 hover:bg-slate-600 disabled:bg-slate-700/50 disabled:cursor-not-allowed text-slate-300 font-semibold py-2 px-4 rounded-md transition-all min-w-[150px]"
                            title="Load prompts from the shared Google Sheet"
                        >
                            {isImportingPrompts ? (
                                <>
                                    <Spinner className="animate-spin h-4 w-4 text-slate-300" />
                                    <span>Loading...</span>
                                </>
                            ) : (
                                <>
                                    <SheetIcon className="h-4 w-4" />
                                    <span>Load from Sheet</span>
                                </>
                            )}
                        </button>
                    </div>
                </div>
            </div>
            
            {files.length > 0 ? (
                 <div className='space-y-4'>
                    {files.length > 1 && files.some(f => f.status === 'pending') && (
                        <button
                            onClick={handleGenerateAll}
                            disabled={isActionLocked}
                            className="w-full flex items-center justify-center gap-2 bg-purple-600 hover:bg-purple-500 disabled:bg-slate-600 disabled:cursor-not-allowed text-white font-bold py-3 px-6 rounded-lg shadow-lg transition-all text-lg"
                        >
                            {isBatchConvertingAll ? (
                                <>
                                    <Spinner />
                                    <span>Generating All Files...</span>
                                </>
                            ) : (
                                <>
                                    <SpeakerIcon />
                                    <span>Generate All Pending Files</span>
                                </>
                            )}
                        </button>
                    )}
                    {files.map(file => (
                        <FileCard 
                            key={file.id}
                            file={file}
                            onConvert={handleBatchConvert}
                            onDownload={handleDownloadZip}
                            onDownloadMerged={handleDownloadMerged}
                            onRemove={handleRemoveFile}
                            onRetryLine={handleRetryLine}
                            isActionLocked={isActionLocked}
                        />
                    ))}
                </div>
            ) : (
                 !isKeySaved ? null : (
                    <div className="border-2 border-dashed border-slate-600 rounded-lg p-12 text-center text-slate-500">
                        <p className="font-semibold text-lg">Upload files to begin</p>
                        <p className="text-sm mt-1">Your uploaded `.txt` and `.srt` files will appear here for conversion.</p>
                    </div>
                 )
            )}

          {globalError && (
              <div className="w-full max-w-3xl mx-auto mt-4 bg-red-900/50 border border-red-500 text-red-300 px-4 py-3 rounded-md text-sm">{globalError}</div>
          )}
        </main>
      </div>
    </div>
  );
};

export default App;
