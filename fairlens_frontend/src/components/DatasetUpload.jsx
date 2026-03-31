import { useRef, useState } from 'react'
import Icon from './Icon'
import styles from './DatasetUpload.module.css'

/**
 * CSV file upload dropzone.
 * Calls onFileSelected(file) when a valid CSV is chosen.
 */
export default function DatasetUpload({ onFileSelected, file }) {
  const inputRef = useRef(null)
  const [dragOver, setDragOver] = useState(false)

  function handleFile(f) {
    if (!f) return
    if (!f.name.endsWith('.csv')) {
      alert('Please upload a CSV file.')
      return
    }
    if (f.size > 5 * 1024 * 1024) {
      alert('File too large. Maximum size is 5MB.')
      return
    }
    onFileSelected(f)
  }

  function handleDrop(e) {
    e.preventDefault()
    setDragOver(false)
    handleFile(e.dataTransfer.files[0])
  }

  return (
    <div
      className={`${styles.dropzone} ${dragOver ? styles.dragOver : ''} ${file ? styles.hasFile : ''}`}
      onClick={() => inputRef.current?.click()}
      onDragOver={e => { e.preventDefault(); setDragOver(true) }}
      onDragLeave={() => setDragOver(false)}
      onDrop={handleDrop}
    >
      <input
        ref={inputRef}
        type="file"
        accept=".csv"
        className={styles.hidden}
        onChange={e => handleFile(e.target.files[0])}
      />

      {file ? (
        <div className={styles.fileInfo}>
          <Icon name='file' size={18}/>
          <div>
            <p className={styles.fileName}>{file.name}</p>
            <p className={styles.fileMeta}>{(file.size / 1024).toFixed(1)} KB · Click to replace</p>
          </div>
          <Icon name='check' size={14}/>
        </div>
      ) : (
        <div className={styles.placeholder}>
          <Icon name='upload' size={28}/>
          <p className={styles.uploadTitle}>Drop your CSV here or click to browse</p>
          <p className={styles.uploadHint}>Max 5MB · Must include a header row</p>
        </div>
      )}
    </div>
  )
}
