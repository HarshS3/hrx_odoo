-- Add employer_cost column to payslips table
ALTER TABLE payslips ADD COLUMN IF NOT EXISTS employer_cost DECIMAL(12,2);
