import styles from './ColumnSelector.module.css'

export default function ColumnSelector({
  columns, targetCol, sensitiveCol, sensitiveCol2,
  onTargetChange, onSensitiveChange, onSensitiveChange2,
  modelType, onModelTypeChange,
  strategy, onStrategyChange,
}) {
  return (
    <div className={styles.wrapper}>
      <div className={styles.group}>
        <label className={styles.label}>
          <span className={styles.dot} style={{ background: '#4f8ef7' }} />
          Target Column
          <span className={styles.hint}>What to predict</span>
        </label>
        <select className={styles.select} value={targetCol}
          onChange={e => onTargetChange(e.target.value)}>
          <option value="">Select column...</option>
          {columns.map(col => <option key={col} value={col}>{col}</option>)}
        </select>
      </div>

      <div className={styles.group}>
        <label className={styles.label}>
          <span className={styles.dot} style={{ background: '#a78bfa' }} />
          Sensitive Attribute
          <span className={styles.hint}>Protected group to audit</span>
        </label>
        <select className={styles.select} value={sensitiveCol}
          onChange={e => onSensitiveChange(e.target.value)}>
          <option value="">Select column...</option>
          {columns.map(col => <option key={col} value={col}>{col}</option>)}
        </select>
      </div>

      <div className={styles.group}>
        <label className={styles.label}>
          <span className={styles.dot} style={{ background: '#34d399' }} />
          2nd Sensitive (optional)
          <span className={styles.hint}>For intersectional bias</span>
        </label>
        <select className={styles.select} value={sensitiveCol2 || ''}
          onChange={e => onSensitiveChange2(e.target.value || null)}>
          <option value="">None</option>
          {columns.map(col => <option key={col} value={col}>{col}</option>)}
        </select>
      </div>

      <div className={styles.group}>
        <label className={styles.label}>
          <span className={styles.dot} style={{ background: '#fbbf24' }} />
          Model Type
          <span className={styles.hint}>Algorithm to train</span>
        </label>
        <select className={styles.select} value={modelType}
          onChange={e => onModelTypeChange(e.target.value)}>
          <option value="logistic_regression">Logistic Regression</option>
          <option value="decision_tree">Decision Tree</option>
          <option value="random_forest">Random Forest</option>
          <option value="gradient_boosting">Gradient Boosting</option>
        </select>
      </div>

      <div className={styles.group} style={{ gridColumn: '1 / -1' }}>
        <label className={styles.label}>
          <span className={styles.dot} style={{ background: '#f87171' }} />
          Mitigation Strategy
          <span className={styles.hint}>How to reduce detected bias</span>
        </label>
        <div className={styles.strategyGrid}>
          {[
            { value: 'reweighing', label: 'Reweighing', desc: 'Adjusts sample weights so all (group, label) combinations are equally represented during training' },
            { value: 'threshold_optimizer', label: 'Threshold Optimisation', desc: 'Finds per-group decision thresholds that minimise the fairness gap after training' },
            { value: 'drop_sensitive', label: 'Drop Sensitive Features', desc: 'Removes the protected attribute from features entirely before training' },
          ].map(s => (
            <div
              key={s.value}
              className={`${styles.strategyCard} ${strategy === s.value ? styles.strategyActive : ''}`}
              onClick={() => onStrategyChange(s.value)}
            >
              <div className={styles.strategyHeader}>
                <span className={styles.strategyRadio}>{strategy === s.value ? '●' : '○'}</span>
                <strong>{s.label}</strong>
              </div>
              <p className={styles.strategyDesc}>{s.desc}</p>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}
