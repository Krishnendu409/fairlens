import styles from './MetricsTable.module.css'

const METRIC_DISPLAY = {
  demographic_parity_difference: 'Demographic Parity Difference',
  equalized_odds_difference: 'Equalized Odds Difference',
  disparate_impact_ratio: 'Disparate Impact Ratio',
  accuracy_parity_difference: 'Accuracy Parity Difference',
  selection_rate_difference: 'Selection Rate Difference',
}

const THRESHOLDS = {
  demographic_parity_difference: '< 0.10',
  equalized_odds_difference: '< 0.10',
  disparate_impact_ratio: '≥ 0.80',
  accuracy_parity_difference: '< 0.05',
  selection_rate_difference: '< 0.10',
}

const DESCRIPTIONS = {
  demographic_parity_difference: 'Difference in positive-prediction rates between groups',
  equalized_odds_difference: 'Max difference in TPR or FPR between groups',
  disparate_impact_ratio: 'Ratio of selection rates — 4/5 rule (≥0.80 is fair)',
  accuracy_parity_difference: 'Difference in model accuracy between groups',
  selection_rate_difference: 'Absolute difference in positive prediction rates',
}

export default function MetricsTable({ metricsBefore, metricsAfter, flagsBefore, flagsAfter }) {
  const metrics = Object.keys(metricsBefore)

  return (
    <div className={styles.wrapper}>
      <div className={styles.tableWrapper}>
        <table className={styles.table}>
          <thead>
            <tr>
              <th>Metric</th>
              <th>Threshold</th>
              <th>Before</th>
              <th>Status</th>
              {metricsAfter && <th>After</th>}
              {metricsAfter && <th>Status</th>}
            </tr>
          </thead>
          <tbody>
            {metrics.map(metric => {
              const before = metricsBefore[metric]
              const after = metricsAfter?.[metric]
              const flagBefore = flagsBefore?.[metric]
              const flagAfter = flagsAfter?.[metric]
              const improved = after !== undefined && flagBefore && !flagAfter

              return (
                <tr key={metric}>
                  <td>
                    <div className={styles.metricName}>
                      {METRIC_DISPLAY[metric] || metric}
                    </div>
                    <div className={styles.metricDesc}>{DESCRIPTIONS[metric]}</div>
                  </td>
                  <td className={styles.threshold}>{THRESHOLDS[metric]}</td>
                  <td className={`${styles.value} ${flagBefore ? styles.valueBad : styles.valueGood}`}>
                    {before?.toFixed(4)}
                  </td>
                  <td>
                    <span className={`${styles.badge} ${flagBefore ? styles.badgeBad : styles.badgeGood}`}>
                      {flagBefore ? 'Bias' : 'OK'}
                    </span>
                  </td>
                  {metricsAfter && (
                    <td className={`${styles.value} ${flagAfter ? styles.valueBad : styles.valueGood}`}>
                      {after?.toFixed(4)}
                      {improved && <span className={styles.improvement}> ↑</span>}
                    </td>
                  )}
                  {metricsAfter && (
                    <td>
                      <span className={`${styles.badge} ${flagAfter ? styles.badgeBad : styles.badgeGood}`}>
                        {flagAfter ? 'Bias' : 'OK'}
                      </span>
                    </td>
                  )}
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
    </div>
  )
}
