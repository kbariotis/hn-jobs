const prompt = `For the Job Post posted below, tell me which one of these options fit best: 
            - 'Python backend engineer remote'
            - 'Remote full-time software engineer (US)'
            - 'React / Typescript frontend remote job'
            - 'PostgreSQL backend engineer Europe'
            - 'Full-stack / backend startup job'
            - 'Hybrid / on-site European engineer job'
            - 'Go / Golang infrastructure engineer remote Europe'
            - 'Platform / SRE engineer remote (cloud / Kubernetes)'
            - 'Startup early-stage founding / early team engineer'
            - 'Security / DevOps engineer US remote'
            - 'Backend engineer fintech / payments EU'. 
            
            Respond with just the option that has the most probability of fully representing the job post.
            
            Respond only with the option and no other explanation and include the probability (a number from 0 to 1000) at the end in a single line.

            Job Post:`;

export default prompt;
