//! Final report generation: the baseline → optimized benchmark table.

use crate::suite::SuiteResult;

/// One row of the final report.
pub struct ReportRow {
    pub name: String,
    pub unit: String,
    pub better: String,
    pub baseline: f64,
    pub optimized: f64,
}

impl ReportRow {
    /// Is a row that MOVED an improvement?
    ///
    /// `"same"` marks a diagnostic where any movement is bad news rather than
    /// good — `forms.span_samples` is the count the span rows were computed
    /// over, so a difference means the two results did not run the same
    /// benchmark and every delta beside it is suspect.
    pub fn improved(&self) -> bool {
        match self.better.as_str() {
            "higher" => self.optimized > self.baseline,
            "same" => false,
            _ => self.optimized < self.baseline,
        }
    }

    /// Human description of the improvement, unit-aware.
    pub fn improvement(&self) -> String {
        let (b, o) = (self.baseline, self.optimized);
        if !b.is_finite() || !o.is_finite() {
            return "n/a".into();
        }
        if (b - o).abs() < 1e-9 {
            return "unchanged".into();
        }
        match self.unit.as_str() {
            "%" => {
                let pp = o - b;
                format!("{pp:+.2} pp")
            }
            "count" => format!("{} → {}", b as i64, o as i64),
            _ => {
                if b.abs() < 1e-9 {
                    return format!("{b:.2} → {o:.2}");
                }
                let rel = (o - b) / b * 100.0;
                match self.better.as_str() {
                    "higher" => format!("{rel:+.1}%"),
                    _ => format!("{:.1}% lower", -rel),
                }
            }
        }
    }

    /// Direction-normalized relative improvement. Positive is better, negative
    /// is worse, regardless of whether the metric itself prefers higher or
    /// lower values. A zero baseline has no meaningful relative denominator.
    pub fn improvement_percent(&self) -> String {
        let (b, o) = (self.baseline, self.optimized);
        if !b.is_finite() || !o.is_finite() {
            return "n/a".into();
        }
        if (b - o).abs() < 1e-9 {
            return "0.0%".into();
        }
        if b.abs() < 1e-9 || self.better == "same" {
            return "n/a".into();
        }
        let raw = (o - b) / b.abs() * 100.0;
        let normalized = match self.better.as_str() {
            "higher" => raw,
            "lower" => -raw,
            _ => 0.0,
        };
        format!("{normalized:+.1}%")
    }
}

pub fn rows(baseline: &SuiteResult, optimized: &SuiteResult) -> Vec<ReportRow> {
    baseline
        .table
        .iter()
        .filter_map(|b| {
            optimized.table.iter().find(|o| o.name == b.name).map(|o| ReportRow {
                name: b.name.clone(),
                unit: b.unit.clone(),
                better: b.better.clone(),
                baseline: b.value,
                optimized: o.value,
            })
        })
        .collect()
}

pub fn markdown_table(rows: &[ReportRow]) -> String {
    let mut out = String::new();
    out.push_str(
        "| Benchmark | Unit | Better | Baseline | Optimized | Change | % improvement |\n",
    );
    out.push_str("|---|---|---|---:|---:|---|---:|\n");
    for r in rows {
        let marker = if (r.baseline - r.optimized).abs() < 1e-9 {
            ""
        } else if r.improved() {
            " ✅"
        } else {
            " ⚠️"
        };
        out.push_str(&format!(
            "| `{}` | {} | {} | {:.3} | {:.3} | {}{} | {} |\n",
            r.name,
            r.unit,
            r.better,
            r.baseline,
            r.optimized,
            r.improvement(),
            marker,
            r.improvement_percent(),
        ));
    }
    out
}

#[cfg(test)]
mod tests {
    use super::ReportRow;

    fn row(better: &str, baseline: f64, optimized: f64) -> ReportRow {
        ReportRow {
            name: "metric".into(),
            unit: "atoms".into(),
            better: better.into(),
            baseline,
            optimized,
        }
    }

    #[test]
    fn relative_improvement_is_positive_in_either_better_direction() {
        assert_eq!(row("higher", 50.0, 60.0).improvement_percent(), "+20.0%");
        assert_eq!(row("lower", 50.0, 40.0).improvement_percent(), "+20.0%");
        assert_eq!(row("lower", 50.0, 60.0).improvement_percent(), "-20.0%");
        assert_eq!(row("higher", 0.0, 1.0).improvement_percent(), "n/a");
    }
}
